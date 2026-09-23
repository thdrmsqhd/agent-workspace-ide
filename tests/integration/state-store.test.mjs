import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { StateStore } from "@awi/persistence";

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "awi-state-"));
  const file = join(directory, "state.sqlite");
  const store = await StateStore.open(file);
  t.after(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  const project = store.createProject("앱", directory, "repo-key", "main");
  const taskId = store.createDiscussion(project, "원래 요청 전문");
  store.recordPreparedExecution(taskId, 0, join(directory, "worktree"));
  return { store, file, taskId };
}

function command(taskId, expectedRevision, text = "지시", requestId = randomUUID()) {
  return { apiVersion: 1, requestId, method: "task.send", taskId, expectedRevision,
    payload: { text, attachmentIds: [], delivery: "queued" } };
}

test("큐·operation·이벤트를 한 트랜잭션으로 저장하고 재시작 후 복원한다", async (t) => {
  const { store, file, taskId } = await fixture(t);
  const input = command(taskId, 1);
  const first = store.applyQueueCommand(input);
  const eventCount = store.eventCount();
  const again = store.applyQueueCommand(input);
  assert.deepEqual(again, first);
  assert.equal(store.eventCount(), eventCount);
  assert.throws(() => store.applyQueueCommand({ ...input, payload: { ...input.payload, text: "다른 명령" } }), /E_REQUEST_REUSE/);
  assert.throws(() => store.applyQueueCommand(command(taskId, 1, "오래된 요청")), (e) => e.code === "E_REVISION_CONFLICT");

  const changed = store.applyQueueCommand({ apiVersion: 1, requestId: randomUUID(), method: "queue.update",
    taskId, expectedRevision: 0, payload: { messageId: first.messageId, text: "수정", attachmentIds: [] } });
  assert.equal(changed.task.messages[0].text, "수정");
  const backupFile = await store.backupSnapshot();
  assert.ok((await stat(backupFile)).size > 0);
  const backupDb = new DatabaseSync(backupFile);
  assert.equal(backupDb.prepare("SELECT original_prompt FROM tasks WHERE id=?").get(taskId).original_prompt, "원래 요청 전문");
  assert.equal(backupDb.prepare("SELECT content FROM messages WHERE id=?").get(first.messageId).content, "수정");
  backupDb.close();

  const reopened = await StateStore.open(file);
  assert.equal(reopened.getTaskQueue(taskId).messages[0].text, "수정");
  assert.deepEqual(reopened.applyQueueCommand(input), first);
  reopened.close();
});

test("operation 기록 실패는 메시지·revision·이벤트까지 되돌린다", async (t) => {
  const { store, file, taskId } = await fixture(t);
  const injected = new DatabaseSync(file);
  injected.exec("CREATE TRIGGER fail_operation BEFORE INSERT ON operations BEGIN SELECT RAISE(ABORT,'injected failure'); END");
  injected.close();
  const before = store.getTaskQueue(taskId);
  const count = store.eventCount();
  assert.throws(() => store.applyQueueCommand(command(taskId, before.revision)), /injected failure/);
  assert.deepEqual(store.getTaskQueue(taskId), before);
  assert.equal(store.eventCount(), count);
  const verify = new DatabaseSync(file);
  assert.equal(verify.prepare("SELECT COUNT(*) AS n FROM messages").get().n, 0);
  assert.equal(verify.prepare("PRAGMA foreign_key_check").all().length, 0);
  assert.throws(() => verify.prepare("INSERT INTO tasks(id,project_id,original_prompt,phase,run_state,created_at,updated_at) VALUES(?,?,'x','discussion','idle',?,?)").run(randomUUID(), randomUUID(), new Date().toISOString(), new Date().toISOString()), /FOREIGN KEY/);
  verify.close();
});

test("전달 중 재시작 시 unknown으로 격리하고 대기 지시를 다시 보내지 않는다", async (t) => {
  const { store, file, taskId } = await fixture(t);
  const first = store.applyQueueCommand(command(taskId, 1, "M1"));
  store.applyQueueCommand(command(taskId, 2, "M2"));
  const edit = new DatabaseSync(file);
  edit.prepare("UPDATE tasks SET run_state='idle' WHERE id=?").run(taskId);
  edit.close();
  assert.equal(store.claimNextMessage(taskId).id, first.messageId);
  assert.equal(store.claimNextMessage(taskId), undefined);
  const reopened = await StateStore.open(file);
  const state = reopened.getTaskQueue(taskId);
  assert.equal(state.runState, "paused");
  assert.equal(state.queueMode, "paused");
  assert.deepEqual(state.messages.map((message) => message.state), ["unknown", "queued"]);
  assert.equal(reopened.claimNextMessage(taskId), undefined);
  reopened.close();
});

test("알 수 없는 기존 스키마는 보존하며 빈 DB로 덮지 않는다", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "awi-legacy-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, "state.sqlite");
  const legacy = new DatabaseSync(file);
  legacy.exec("CREATE TABLE legacy(value TEXT); INSERT INTO legacy VALUES('유지');");
  legacy.close();
  await assert.rejects(StateStore.open(file), /알 수 없는 기존 DB 스키마/);
  const preserved = new DatabaseSync(file);
  assert.equal(preserved.prepare("SELECT value FROM legacy").get().value, "유지");
  preserved.close();
});
