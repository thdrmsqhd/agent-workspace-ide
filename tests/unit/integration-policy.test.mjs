import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanupBlockers, createReviewArtifact, planFollowup } from "@awi/integration";

test("워크트리는 미저장/프로세스/디버거/반영 상태가 안전할 때만 정리 가능하다", () => {
  assert.deepEqual(cleanupBlockers({ dirtyWorktree:false, runningProcesses:0, dirtyBuffers:0, activeDebuggers:0, integrationState:"done" }), []);
  const blocked = cleanupBlockers({ dirtyWorktree:true, runningProcesses:1, dirtyBuffers:2, activeDebuggers:1, integrationState:"conflicted" });
  assert.equal(blocked.length, 5);
});

test("병합 전 후속은 같은 작업, 병합 후 후속은 최신 기준 연결 작업이다", () => {
  assert.deepEqual(planFollowup("T", false, "main"), { kind:"same-task", taskId:"T" });
  assert.deepEqual(planFollowup("T", true, "origin/main"), { kind:"linked-task", previousTaskId:"T", baseRef:"origin/main" });
});

test("검토 결과는 미실행 검사를 통과로 위장하지 않는다", () => {
  const artifact = createReviewArtifact({
    originalPrompt:"기능 구현", followups:["추가"], summary:"완료", changedFiles:["a.ts"],
    checks:[{name:"unit",status:"passed"},{name:"e2e",status:"not_run"}], urls:[], integrationActions:["merge"]
  });
  assert.equal(artifact.checks[1].status, "not_run");
});
