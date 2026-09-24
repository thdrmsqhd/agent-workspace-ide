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
const ID = "AT-03";
const TITLE = "워크트리 준비, 시작 이중 클릭, 준비 실패 후 같은 단계 재시도";
const PRECONDITION = "빈 저장소를 main으로 초기화하고 프로젝트를 등록한 뒤 워크트리 준비를 시도한다.";
const EXPECTED = "준비 결과가 메인 저장소 + 워크트리 하나, 기준 커밋 고정, 실패한 준비는 원본을 건드리지 않고 같은 단계로 재시도된다.";
const ENGINE_NOTE = "엔진은 저장소 시험용 fake-omp-engine 픽스처를 썼다. 이 AT의 기대는 워크트리·기준 커밋·재시도라는 Git 계층 사실이며 엔진 동작을 주장하지 않는다.";
const fakeEngine = fileURLToPath(new URL("../../../tests/fixtures/fake-omp-engine.mjs", import.meta.url));

async function git(cwd, ...args) {
  return (await run("git", args, { cwd })).stdout;
}

/** git은 경로를 슬래시로 돌려주고 Windows의 join은 역슬래시를 쓴다. 같은 경로를 같게 보이도록 정규화한다. */
function samePath(left, right) {
  return left.split("\\").join("/").toLowerCase() === right.split("\\").join("/").toLowerCase();
}

async function worktrees(cwd) {
  const output = await git(cwd, "worktree", "list", "--porcelain");
  const entries = [];
  for (const block of output.split("\n\n")) {
    const lines = block.split("\n").filter((line) => line.length > 0);
    if (lines.length === 0) continue;
    const entry = {};
    for (const line of lines) {
      const [key, ...rest] = line.split(" ");
      entry[key] = rest.join(" ").trim();
    }
    entries.push({ path: entry.worktree, head: entry.HEAD, branch: entry.branch ?? "" });
  }
  return entries;
}

export default {
  id: ID,
  title: TITLE,
  precondition: PRECONDITION,
  expected: EXPECTED,
  async run() {
    const log = createStepLog();
    const root = await mkdtemp(join(tmpdir(), "awi-at03-"));
    const repo = join(root, "repo");
    await mkdir(repo);
    await git(repo, "init", "-b", "main");
    await git(repo, "config", "user.name", "AWi AT");
    await git(repo, "config", "user.email", "at@example.invalid");
    await writeFile(join(repo, "README.md"), "base\n");
    await git(repo, "add", ".");
    await git(repo, "commit", "-m", "base");
    const baseCommit = (await git(repo, "rev-parse", "HEAD")).trim();

    const store = await StateStore.open(join(root, "state.sqlite"));
    const supervisor = new ProcessTreeSupervisor();
    const settings = new SettingsRegistry();
    const engineFactory = {
      async create(taskId, cwd, _snapshot, _phase, sessionFile) {
        const adapter = new OmpEngineAdapter(supervisor);
        await adapter.start({ taskId, executable: process.execPath, args: [fakeEngine], cwd });
        if (sessionFile) await adapter.switchSession(sessionFile);
        return adapter;
      },
    };
    const runtime = new WorkspaceRuntime({
      store,
      settings,
      supervisor,
      engineFactory,
      worktreeRoot: join(root, "worktrees"),
      journalDirectory: join(root, "journals"),
    });

    const summary = [];
    let worktreePath = "";
    let branchName = "";
    let finalCount = 0;
    try {
      const projectId = await runtime.registerProject("AT-03", repo, "main", { engine: "omp", model: "fake", mode: "manual" });
      const taskId = await runtime.createDiscussion(projectId, "AT-03 워크트리 준비");

      await assert.rejects(() => runtime.startTask(taskId, "no-such-base"), (error) => error instanceof Error);
      const afterFailure = await worktrees(repo);
      assert.equal(afterFailure.length, 1, "실패한 준비가 워크트리를 남기면 안 된다");
      assert.equal(store.getTaskInfo(taskId).phase, "discussion", "실패 후에도 재시도할 수 있어야 한다");
      assert.equal((await git(repo, "rev-parse", "HEAD")).trim(), baseCommit, "원본 HEAD가 움직이면 안 된다");
      log.ok("없는 기준 ref로 준비 실패", `워크트리 ${afterFailure.length}개(메인만), phase=discussion, HEAD=${baseCommit.slice(0, 7)} 유지`);

      // 준비 기록이 남아 있으면 같은 작업 재시도가 "준비 기록이 이미 있습니다"로 막힌다. 이 재시도가 그 정리를 함께 검증한다.
      await runtime.startTask(taskId, "main");
      const afterRetry = await worktrees(repo);
      assert.equal(afterRetry.length, 2, "메인 + 워크트리 하나여야 한다");
      const created = afterRetry.find((entry) => !samePath(entry.path, repo));
      assert.ok(created, "워크트리가 만들어져야 한다");
      assert.equal(created.head, baseCommit, "기준 커밋이 고정되어야 한다");
      assert.equal(created.branch, `refs/heads/awi/task/${taskId}`, "작업 브랜치가 고정 이름 규칙을 따른다");
      assert.equal(store.getTaskInfo(taskId).phase, "execution");
      worktreePath = created.path;
      branchName = created.branch;
      log.ok("같은 단계 재시도 성공", `${worktreePath} @ ${created.head.slice(0, 7)} (${branchName})`);

      await assert.rejects(() => runtime.startTask(taskId, "main"), /논의 상태의 작업만 시작할 수 있습니다/);
      finalCount = (await worktrees(repo)).length;
      assert.equal(finalCount, 2, "이중 시작이 워크트리를 늘리면 안 된다");
      log.ok("시작 이중 클릭 거부", `phase=execution이라 두 번째 startTask가 거부되고 워크트리는 ${finalCount}개(메인 포함) 유지`);

      summary.push(`메인 + 워크트리 ${finalCount - 1}개`, `기준 커밋 ${baseCommit.slice(0, 7)} 고정`, "준비 실패 후 같은 단계 재시도 성공");
    } finally {
      await runtime.shutdown();
      store.close();
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }

    const artifacts = [
      await saveArtifact(ID, "worktrees.json", { baseCommit, worktreePath, branchName, worktreeCount: finalCount, engine: "tests/fixtures/fake-omp-engine.mjs" }),
      await saveArtifact(ID, "steps.txt", `${log.steps.map((step) => `${step.result}\t${step.name}\t${step.detail}`).join("\n")}\n`),
    ];
    const record = await writeEvidence({
      id: ID,
      status: "PASS",
      title: TITLE,
      scenario: "scripts/acceptance/scenarios/at-03-start-task.mjs",
      detail: `워크트리 하나(메인 포함 ${finalCount}개)·기준 커밋 고정·이중 시작 거부·실패 후 재시도 확인. ${ENGINE_NOTE}`,
      precondition: PRECONDITION,
      expected: EXPECTED,
      steps: log.steps,
      actual: summary.join(" | "),
      artifacts,
    });
    return { status: record.status, detail: record.detail };
  },
};
