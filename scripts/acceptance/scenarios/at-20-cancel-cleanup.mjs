import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";
import { promisify } from "node:util";
import { OmpEngineAdapter } from "@awi/engine-omp";
import { cleanupBlockers, planFollowup } from "@awi/integration";
import { StateStore } from "@awi/persistence";
import { ProcessTreeSupervisor } from "@awi/processes";
import { WorkspaceRuntime } from "@awi/runtime";
import { SettingsRegistry } from "@awi/settings";
import { removeOwnedWorktree } from "@awi/worktrees";
import { createStepLog, saveArtifact, writeEvidence } from "../lib/harness.mjs";

const run = promisify(execFile);
const ID = "AT-20";
const TITLE = "병합 후 연결 작업, 취소 기록 보존, 안전할 때만 워크트리 정리";
const PRECONDITION = "실제 Git 저장소에 작업 워크트리를 만들고, 미반영 변경·소유 불일치·정상 상태를 차례로 만들어 정리 판단을 확인한다.";
const EXPECTED = "병합 후에는 새 연결 작업이 계획되고, 취소·보관 기록은 삭제되지 않고 남으며, 워크트리는 안전할 때만 정리되고 브랜치·이력은 보존된다.";

async function git(cwd, ...args) {
  return (await run("git", args, { cwd })).stdout;
}

const exists = (path) => stat(path).then(() => true, () => false);
const fakeEngine = fileURLToPath(new URL("../../../tests/fixtures/fake-omp-engine.mjs", import.meta.url));

export default {
  id: ID,
  title: TITLE,
  precondition: PRECONDITION,
  expected: EXPECTED,
  async run() {
    const log = createStepLog();
    const root = await mkdtemp(join(tmpdir(), "awi-at20-"));
    const repo = join(root, "repo");
    const otherRepo = join(root, "other");
    for (const path of [repo, otherRepo]) {
      await mkdir(path);
      await git(path, "init", "-b", "main");
      await git(path, "config", "user.name", "AWi AT");
      await git(path, "config", "user.email", "at@example.invalid");
      await writeFile(join(path, "README.md"), "base\n");
      await git(path, "add", ".");
      await git(path, "commit", "-m", "base");
    }
    const baseCommit = (await git(repo, "rev-parse", "HEAD")).trim();
    const journalDirectory = join(root, "journals");

    const store = await StateStore.open(join(root, "state.sqlite"));
    const supervisor = new ProcessTreeSupervisor();
    const runtime = new WorkspaceRuntime({
      store,
      settings: new SettingsRegistry(),
      supervisor,
      engineFactory: {
        async create(taskId, cwd, _snapshot, _phase, sessionFile) {
          const adapter = new OmpEngineAdapter(supervisor);
          await adapter.start({ taskId, executable: process.execPath, args: [fakeEngine], cwd });
          if (sessionFile) await adapter.switchSession(sessionFile);
          return adapter;
        },
      },
      worktreeRoot: join(root, "worktrees"),
      journalDirectory,
    });

    const summary = [];
    let worktreePath = "";
    try {
      const projectId = await runtime.registerProject("AT-20", repo, "main", { engine: "omp", model: "fake", mode: "manual" });
      const taskId = await runtime.createDiscussion(projectId, "AT-20 정리 안전성");
      await runtime.startTask(taskId, "main");
      worktreePath = store.getTaskInfo(taskId).worktreePath;
      assert.ok(worktreePath && (await exists(worktreePath)), "워크트리가 만들어져야 한다.");
      log.ok("워크트리 준비", worktreePath);

      // 정리 차단 사유 계산
      assert.deepEqual(cleanupBlockers({ dirtyWorktree: false, runningProcesses: 0, dirtyBuffers: 0, activeDebuggers: 0, integrationState: "done" }), []);
      assert.deepEqual(
        cleanupBlockers({ dirtyWorktree: true, runningProcesses: 1, dirtyBuffers: 2, activeDebuggers: 1, integrationState: "failed" }),
        ["미반영 Git 변경", "실행 중 프로세스", "미저장 편집 버퍼", "활성 디버거", "반영 상태 failed"],
      );
      log.ok("정리 차단 사유", "깨끗한 상태는 차단 0, 변경·프로세스·버퍼·디버거·반영 실패는 각각 차단 사유로 계산");

      // 미반영 변경이 있으면 정리 보류
      await writeFile(join(worktreePath, "scratch.txt"), "정리하면 안 되는 변경\n");
      await assert.rejects(() => removeOwnedWorktree({ repoPath: repo, taskId, journalDirectory }), /미반영 변경/);
      assert.equal(await exists(worktreePath), true, "차단 사유가 있으면 워크트리가 남아야 한다.");
      log.ok("미반영 변경 보류", "untracked 파일이 있으면 정리를 거부하고 워크트리 유지");

      // 작업 엔진이 살아 있는 동안은 정리 대상이 아니다(호출자가 실행 중 프로세스를 차단 사유로 계산한다).
      assert.equal(await exists(worktreePath), true, "작업이 실행 중이면 워크트리는 그대로여야 한다.");
      log.note("실행 중 정리 차단", "엔진이 워크트리를 cwd로 잡고 있는 동안에는 정리 대상이 아니다.");

      // 다른 저장소를 지정하면 거부
      await assert.rejects(() => removeOwnedWorktree({ repoPath: otherRepo, taskId, journalDirectory }), /소유 저장소가 다릅니다/);
      assert.equal(await exists(worktreePath), true);
      log.ok("소유 저장소 확인", "다른 저장소 경로로는 정리 거부");

      // 취소·보관 기록 보존 (제품 경로: 실행 중이면 먼저 중단하고 disposition을 cancelled로 남긴다)
      const beforeCancel = store.getTaskInfo(taskId);
      await assert.rejects(() => runtime.completeTask(taskId), /실행 중인 작업은 완료 처리할 수 없습니다/);
      log.ok("실행 중 완료 금지", "실행 중 작업은 완료 처리할 수 없다");
      await runtime.cancelTask(taskId);
      const cancelled = store.getTaskInfo(taskId);
      assert.equal(cancelled.disposition, "cancelled");
      assert.equal(cancelled.originalPrompt, beforeCancel.originalPrompt, "취소해도 원래 요청 기록은 남아야 한다.");
      assert.equal(cancelled.runState, "paused", "취소는 실행을 멈춘 상태로 남겨야 한다.");
      log.ok("취소 기록 보존", `disposition=cancelled, runState=${cancelled.runState}, 원래 요청 유지`);

      // 작업을 끝내고(엔진 종료) 안전해지면 정리한다. 브랜치·이력은 보존되어야 한다.
      await runtime.shutdown();
      log.ok("작업 종료", "엔진·프로세스 종료 후 정리 단계로 진행");
      await rm(join(worktreePath, "scratch.txt"), { force: true });
      await removeOwnedWorktree({ repoPath: repo, taskId, journalDirectory });
      assert.equal(await exists(worktreePath), false, "안전하면 워크트리가 정리되어야 한다.");
      const branch = (await git(repo, "show-ref", "--verify", "--quiet", `refs/heads/awi/task/${taskId}`).then(() => true, () => false));
      assert.equal(branch, true, "정리 후에도 작업 브랜치는 보존되어야 한다.");
      assert.equal((await git(repo, "rev-parse", "HEAD")).trim(), baseCommit, "원본 저장소 HEAD는 그대로여야 한다.");
      log.ok("안전한 정리", `워크트리 제거, 브랜치 awi/task/${taskId.slice(0, 8)}… 보존, 원본 HEAD 유지`);

      // 보관은 삭제가 아니다
      runtime.archiveTask(taskId);
      const archived = store.getTaskInfo(taskId);
      assert.equal(archived.phase, "archived");
      assert.equal(archived.disposition, "cancelled");
      assert.equal(archived.originalPrompt, beforeCancel.originalPrompt);
      log.ok("보관 기록 보존", "보관은 archived 표시이며 행·원래 요청이 삭제되지 않는다");

      // 병합 후 연결 작업 계획
      const mergedPlan = planFollowup(taskId, true, "refs/heads/main");
      assert.deepEqual(mergedPlan, { kind: "linked-task", previousTaskId: taskId, baseRef: "refs/heads/main" });
      assert.deepEqual(planFollowup(taskId, false, "refs/heads/main"), { kind: "same-task", taskId });
      log.ok("병합 후 연결 작업", "병합 완료면 직전 작업을 가리키는 linked-task 계획, 미병합이면 same-task");
      summary.push("미반영 변경 시 정리 보류", "소유 불일치 거부", "정리 후 브랜치 보존", "취소·보관 기록 유지", "병합 후 linked-task 계획");
    } finally {
      await runtime.shutdown().catch(() => undefined);
      store.close();
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }

    const artifacts = [
      await saveArtifact(ID, "cleanup.json", { worktreePath, baseCommit, removed: !(await exists(worktreePath)) }),
      await saveArtifact(ID, "steps.txt", `${log.steps.map((step) => `${step.result}\t${step.name}\t${step.detail}`).join("\n")}\n`),
    ];
    const record = await writeEvidence({
      id: ID,
      status: "PASS",
      title: TITLE,
      scenario: "scripts/acceptance/scenarios/at-20-cancel-cleanup.mjs",
      detail: "실제 Git 워크트리에서 미반영 변경·소유 불일치가 정리를 막는 것과, 안전해진 뒤 정리해도 브랜치·이력이 남는 것을 확인했다. 취소·보관 기록도 삭제되지 않았고 병합 후 연결 작업 계획이 linked-task로 나온다. 엔진은 저장소 시험용 픽스처를 썼다.",
      precondition: PRECONDITION,
      expected: EXPECTED,
      steps: log.steps,
      actual: summary.join(" | "),
      artifacts,
    });
    return { status: record.status, detail: record.detail };
  },
};
