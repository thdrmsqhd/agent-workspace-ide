import { test } from "node:test";
import assert from "node:assert/strict";
import { acquireSlot, releaseSlot, enqueue, updateQueued, deleteQueued, claimNext, abort, archiveTask, cancelTask, confirmStopped, markUnknown, resume } from "@awi/core";

const task = () => ({ taskId: "A", phase: "execution", runState: "running", integrationState: "none", queueMode: "enabled", revision: 0, messages: [] });
const add = (state, id) => enqueue(state, state.revision, { id, text: id, attachmentIds: [] });

test("수정·삭제는 대기 중에만 가능하고 삭제 지시는 선점하지 않는다", () => {
  let state = add(add(task(), "M1"), "M2");
  state = updateQueued(state, "M1", 0, "수정", []);
  assert.equal(state.messages[0].text, "수정");
  assert.throws(() => updateQueued(state, "M1", 0, "경쟁", []), (e) => e.code === "E_REVISION_CONFLICT");
  state = deleteQueued(state, "M1", 1);
  state = { ...state, runState: "idle" };
  const claimed = claimNext(state);
  assert.equal(claimed.message.id, "M2");
  assert.equal(claimed.task.messages[0].state, "deleted");
  assert.throws(() => deleteQueued(claimed.task, "M2", 1), (e) => e.code === "E_STATE");
});

test("Esc는 처리 완료 전까지 stopping이며 대기열 소비를 멈춘다", () => {
  let state = add(task(), "M1");
  state = abort(state);
  assert.equal(state.runState, "stopping");
  assert.equal(state.queueMode, "paused");
  assert.equal(abort(state), state);
  state = confirmStopped(state);
  assert.equal(claimNext(state).message, undefined);
  state = resume(state, state.revision);
  assert.equal(state.runState, "running");
  assert.equal(claimNext({ ...state, runState: "idle" }).message.id, "M1");
});

test("전달 결과가 불명이면 자동 재전송과 재개를 막는다", () => {
  const initial = { ...add(task(), "M1"), runState: "idle" };
  const { task: claimed } = claimNext(initial);
  const unknown = markUnknown(claimed, "M1");
  assert.equal(unknown.messages[0].state, "unknown");
  assert.equal(claimNext(unknown).message, undefined);
  assert.throws(() => resume(unknown, unknown.revision), (e) => e.code === "E_UNKNOWN_OUTCOME");
});

test("반영 중 수정과 13번째 실행을 거절하며 다른 작업 슬롯은 유지한다", () => {
  const merging = { ...task(), integrationState: "merging" };
  assert.throws(() => add(merging, "M"), (e) => e.code === "E_STATE");
  let active = new Set();
  for (let index = 0; index < 12; index++) active = acquireSlot(active, `T${index}`);
  assert.equal(active.size, 12);
  assert.throws(() => acquireSlot(active, "T12"), (e) => e.code === "E_CAPACITY");
  assert.equal(acquireSlot(active, "T0").size, 12);
  active = releaseSlot(active, "T0");
  active = acquireSlot(active, "T12");
  assert.equal(active.size, 12);
});

test("취소는 기록을 유지하고 실행 중 작업은 정지 상태로 전환하며, 보관은 실행 중에는 거절한다", () => {
  const running = add(task(), "M1");
  assert.throws(() => archiveTask(running), (e) => e.code === "E_STATE");
  const cancelled = cancelTask({ ...running, runState:"idle" });
  assert.equal(cancelled.queueMode, "paused");
  assert.equal(cancelled.runState, "paused");
  const archived = archiveTask(cancelled);
  assert.equal(archived.phase, "archived");
});
