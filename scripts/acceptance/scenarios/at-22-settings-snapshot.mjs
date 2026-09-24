import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";
import { promisify } from "node:util";
import { OmpEngineAdapter } from "@awi/engine-omp";
import { StateStore } from "@awi/persistence";
import { ProcessTreeSupervisor } from "@awi/processes";
import { WorkspaceRuntime } from "@awi/runtime";
import { SettingsRegistry } from "@awi/settings";
import { createStepLog, saveArtifact, writeEvidence } from "../lib/harness.mjs";

const run = promisify(execFile);
const ID = "AT-22";
const TITLE = "프로젝트 기본값 변경과 작업 설정 스냅샷 불변·재시작 복원";
const PRECONDITION = "프로젝트 기본 설정을 만들고 작업 스냅샷을 캡처한 뒤 기본값을 바꾸고, 프로세스를 재시작해 복원을 확인한다.";
const EXPECTED = "기본값 변경은 새 작업에만 적용되고 이미 캡처된 작업(실행 중 포함) 스냅샷은 변하지 않으며, 재시작 후에도 스냅샷이 복원된다.";
const ENGINE_NOTE = "엔진은 저장소 시험용 fake-omp-engine 픽스처다. 이 AT는 설정 스냅샷의 적용 범위와 불변성이라는 제품 계층 사실을 본다.";
const fakeEngine = fileURLToPath(new URL("../../../tests/fixtures/fake-omp-engine.mjs", import.meta.url));

async function git(cwd, ...args) {
  return (await run("git", args, { cwd })).stdout;
}

export default {
  id: ID,
  title: TITLE,
  precondition: PRECONDITION,
  expected: EXPECTED,
  async run() {
    const log = createStepLog();
    const root = await mkdtemp(join(tmpdir(), "awi-at22-"));
    const repo = join(root, "repo");
    await mkdir(repo);
    await git(repo, "init", "-b", "main");
    await git(repo, "config", "user.name", "AWi AT");
    await git(repo, "config", "user.email", "at@example.invalid");
    await writeFile(join(repo, "README.md"), "base\n");
    await git(repo, "add", ".");
    await git(repo, "commit", "-m", "base");

    const dbPath = join(root, "state.sqlite");
    const supervisor = new ProcessTreeSupervisor();
    const captured = new Map();
    const factory = {
      async create(taskId, cwd, snapshot, _phase, sessionFile) {
        captured.set(taskId, { ...snapshot });
        const adapter = new OmpEngineAdapter(supervisor);
        await adapter.start({ taskId, executable: process.execPath, args: [fakeEngine], cwd });
        if (sessionFile) await adapter.switchSession(sessionFile);
        return adapter;
      },
    };
    const openRuntime = async () => {
      const store = await StateStore.open(dbPath);
      const runtime = new WorkspaceRuntime({
        store, settings: new SettingsRegistry(), supervisor, engineFactory: factory,
        worktreeRoot: join(root, "worktrees"), journalDirectory: join(root, "journals"),
      });
      return { store, runtime };
    };

    const summary = [];
    let runtime;
    let store;
    try {
      ({ store, runtime } = await openRuntime());
      const projectId = await runtime.registerProject("AT-22", repo, "main", { engine: "omp", model: "model-a", mode: "manual" });
      const task1 = await runtime.createDiscussion(projectId, "작업 1", { mode: "automatic" });
      const snap1 = store.getSettingsSnapshot("task", task1).settings;
      assert.equal(snap1.model, "model-a");
      assert.equal(snap1.mode, "automatic");
      log.ok("작업 1 스냅샷", `model=${snap1.model}, mode=${snap1.mode}, sourceRevision=${snap1.sourceRevision}`);

      assert.throws(() => runtime.updateProjectSettings(projectId, { engine: "omp", model: "model-b", mode: "manual" }, 999), /E_REVISION_CONFLICT/);
      log.ok("오래된 revision 거부", "기대 revision이 다르면 E_REVISION_CONFLICT");

      const revisionAfterChange = runtime.updateProjectSettings(projectId, { engine: "omp", model: "model-b", mode: "manual" }, 0);
      log.ok("프로젝트 기본값 변경", `model-a → model-b, revision=${revisionAfterChange}`);

      const snap1After = store.getSettingsSnapshot("task", task1).settings;
      assert.equal(snap1After.model, "model-a", "기본값을 바꿔도 캡처된 작업 스냅샷은 변하면 안 된다.");
      assert.equal(snap1After.mode, "automatic");
      log.ok("작업 1 스냅샷 불변", `model=${snap1After.model}, mode=${snap1After.mode} 유지`);

      const task2 = await runtime.createDiscussion(projectId, "작업 2");
      const snap2 = store.getSettingsSnapshot("task", task2).settings;
      assert.equal(snap2.model, "model-b", "새 작업은 바뀐 기본값을 받아야 한다.");
      assert.equal(snap2.mode, "manual");
      log.ok("작업 2 스냅샷", `model=${snap2.model}, mode=${snap2.mode} (변경된 기본값 반영)`);

      await runtime.startTask(task1, "main");
      assert.equal(captured.get(task1).model, "model-a", "실행 시작 시 캡처된 스냅샷을 써야 한다.");
      assert.equal(captured.get(task1).mode, "automatic");
      log.ok("실행 시작 스냅샷", `task1 = model-a/automatic`);

      runtime.updateProjectSettings(projectId, { engine: "omp", model: "model-c", mode: "manual" }, revisionAfterChange);
      const snap1WhileRunning = store.getSettingsSnapshot("task", task1).settings;
      assert.equal(snap1WhileRunning.model, "model-a", "실행 중 기본값 변경이 실행 중 작업에 영향을 주면 안 된다.");
      log.ok("실행 중 기본값 변경", "model-c로 바꿔도 실행 중 task1은 model-a 유지");
      summary.push("기본값 model-a→model-b→model-c 변경에도 기존 작업 스냅샷 불변", "새 작업만 변경 반영");

      await runtime.abortTask(task1);
      await runtime.shutdown();
      store.close();
      log.ok("종료", "스냅샷 복원을 보기 위해 실행을 멈추고 프로세스 종료");

      ({ store, runtime } = await openRuntime());
      captured.delete(task1);
      await runtime.resumeTask(task1);
      const restored = captured.get(task1);
      assert.equal(restored.model, "model-a", "재시작 후에는 원래 캡처된 스냅샷이 복원되어야 한다.");
      assert.equal(restored.mode, "automatic");
      log.ok("재시작 복원", `빈 SettingsRegistry로 시작했는데도 task1 = ${restored.model}/${restored.mode} 복원(기본값은 ${"model-c"})`);
      summary.push("재시작 후 DB 스냅샷 복원 확인");
    } finally {
      if (runtime) await runtime.shutdown().catch(() => undefined);
      if (store) store.close();
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }

    const artifacts = [
      await saveArtifact(ID, "snapshots.json", { captured: Object.fromEntries(captured) }),
      await saveArtifact(ID, "steps.txt", `${log.steps.map((step) => `${step.result}\t${step.name}\t${step.detail}`).join("\n")}\n`),
    ];
    const record = await writeEvidence({
      id: ID,
      status: "PASS",
      title: TITLE,
      scenario: "scripts/acceptance/scenarios/at-22-settings-snapshot.mjs",
      detail: `프로젝트 기본값을 model-a→model-b→model-c로 바꾸는 동안 이미 캡처된 작업 스냅샷이 변하지 않았고, 새 작업만 변경을 받았으며, 재시작 후 DB 스냅샷이 복원됐다. 오래된 revision은 E_REVISION_CONFLICT로 거부됐다. ${ENGINE_NOTE}`,
      precondition: PRECONDITION,
      expected: EXPECTED,
      steps: log.steps,
      actual: summary.join(" | "),
      artifacts,
    });
    return { status: record.status, detail: record.detail };
  },
};
