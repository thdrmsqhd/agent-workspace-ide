import { test } from "node:test";
import assert from "node:assert/strict";
import { decideAction } from "@awi/core";

test("논의는 변경·셸·알 수 없는 도구를 거절한다", () => {
  const policy = { mode: "discussion", policyHash: "p", allowedActions: new Set(["edit", "runLocal", "push"]) };
  assert.equal(decideAction(policy, "read").kind, "allowed");
  assert.equal(decideAction(policy, "edit").kind, "denied");
  assert.equal(decideAction(policy, "runLocal").kind, "denied");
  assert.equal(decideAction(policy, "unknownTool").kind, "denied");
});

test("수동 반영 승인 범위를 스냅샷·HEAD·정책 해시에 결합한다", () => {
  const policy = { mode: "manual", policyHash: "P", snapshotId: "S", targetHead: "H", allowedActions: new Set(["edit", "merge", "push"]) };
  assert.equal(decideAction(policy, "edit").kind, "allowed");
  assert.equal(decideAction(policy, "merge").kind, "needs_approval");
  const approval = { policyHash: "P", snapshotId: "S", targetHead: "H", actions: new Set(["merge"]) };
  assert.equal(decideAction(policy, "merge", approval).kind, "allowed");
  assert.equal(decideAction(policy, "push", approval).kind, "needs_approval");
  assert.equal(decideAction({ ...policy, targetHead: "changed" }, "merge", approval).kind, "needs_approval");
});

test("자동 모드도 명시된 범위 밖 외부 반영을 보류한다", () => {
  const policy = { mode: "automatic", policyHash: "P", allowedActions: new Set(["edit", "runLocal", "createPR"]) };
  assert.equal(decideAction(policy, "createPR").kind, "allowed");
  assert.equal(decideAction(policy, "push").kind, "needs_approval");
});
