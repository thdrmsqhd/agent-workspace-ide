import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
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
  return { store, file, taskId, project };
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

test("프로젝트·작업 초안과 작업별 보기 상태를 재시작 후 유지한다", async (t) => {
  const { store, file, project, taskId } = await fixture(t);
  const initial = store.saveDraft({ scope: "project", ownerId: project, text: "상단 새 요청", attachmentIds: [], revision: 0 }, 0);
  assert.equal(initial.revision, 0);
  store.saveDraft({ ...initial, text: "계속 작성" }, 0);
  store.saveDraft({ scope: "task", ownerId: taskId, text: "작업별 초안", attachmentIds: [], revision: 0 }, 0);
  assert.throws(() => store.saveDraft({ ...initial, text: "과거 값" }, 0), /E_REVISION_CONFLICT/);
  store.saveView({ taskId, layout: { centerMode: "split" }, tabs: [{ taskId, isOpen: false }], cursors: [], scroll: { conversationOffset: 12 }, revision: 0 }, 0);
  store.saveView({ layout: { leftCollapsed: true }, tabs: [], cursors: [], scroll: {}, revision: 0 }, 0);
  const reopened = await StateStore.open(file);
  assert.equal(reopened.getDraft("project", project).text, "계속 작성");
  assert.equal(reopened.getDraft("task", taskId).text, "작업별 초안");
  assert.equal(reopened.getView(taskId).tabs[0].isOpen, false);
  assert.equal(reopened.getView().layout.leftCollapsed, true);
  reopened.close();
});

test("기존 v1 DB를 변경하기 전에 온라인 백업하고 v2로 올린다", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "awi-migration-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, "state.sqlite");
  const store = await StateStore.open(file);
  store.createProject("원본", directory, "repo-key", "main");
  store.close();
  const old = new DatabaseSync(file);
  old.exec("DROP TABLE view_states; DROP TABLE drafts; DROP TABLE attachments; DROP TABLE settings_snapshots; DROP TABLE input_requests; DROP TABLE integration_journals; DROP TABLE process_records; DROP TABLE artifacts; DROP TABLE engine_sessions; DELETE FROM schema_migrations WHERE id>=2;");
  old.close();
  const upgraded = await StateStore.open(file);
  const backups = (await readdir(directory)).filter((name) => name.startsWith("state-backup-") && name.endsWith(".sqlite"));
  assert.equal(backups.length, 1);
  const snapshot = new DatabaseSync(join(directory, backups[0]));
  assert.equal(snapshot.prepare("SELECT COUNT(*) AS n FROM projects").get().n, 1);
  assert.equal(snapshot.prepare("SELECT COUNT(*) AS n FROM schema_migrations").get().n, 1);
  snapshot.close();
  upgraded.close();
});

test("첨부·설정·입력 요청·반영 저널·프로세스·artifact를 재시작 후 복원한다", async (t) => {
  const { store, file, taskId, project } = await fixture(t);
  store.saveAttachment(taskId, { id:"att-1", kind:"file", relativePath:"a.txt", metadata:{ size:3 } });
  assert.equal(store.listAttachments(taskId)[0].relativePath, "a.txt");
  assert.equal(store.saveSettingsSnapshot("project", project, { model:"m1" }), 0);
  assert.equal(store.saveSettingsSnapshot("project", project, { model:"m2" }, 0), 1);
  const input = store.createInputRequest(taskId, { prompt:"값?" });
  assert.equal(store.listPendingInputRequests(taskId).length, 1);
  assert.equal(store.respondInputRequest(input, { text:"답" }).status, "answered");
  assert.throws(() => store.respondInputRequest(input, { text:"중복" }), /E_INPUT_CLOSED/);
  store.saveIntegrationJournal(taskId, { repoKey:"repo", targetRef:"main", expectedHead:"abc", state:"queued", payload:{ action:"merge" } });
  store.recordProcess(taskId, { id:"proc-1", role:"server", pid:1234, startToken:"boot:1", state:"exited" });
  const artifactId = store.saveArtifact(taskId, "review", "reviews/1.json", { ok:true });
  assert.ok(artifactId);
  const reopened = await StateStore.open(file);
  assert.equal(reopened.listAttachments(taskId).length, 1);
  assert.equal(reopened.getSettingsSnapshot("project", project).settings.model, "m2");
  assert.equal(reopened.listPendingInputRequests(taskId).length, 0);
  assert.equal(reopened.getIntegrationJournal(taskId).state, "queued");
  reopened.close();
});

test("만료된 입력 요청은 자동 승인하지 않고 expired로 닫는다", async (t) => {
  const { store, taskId } = await fixture(t);
  const input = store.createInputRequest(taskId, { prompt:"승인?" }, "2000-01-01T00:00:00.000Z");
  assert.throws(() => store.respondInputRequest(input, { allow:true }), /E_INPUT_EXPIRED/);
  assert.equal(store.listPendingInputRequests(taskId).length, 0);
});

test("엔진 세션 참조는 앱 재시작 후 같은 작업 복구에 사용 가능하다", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "awi-engine-session-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, "state.sqlite");
  const store = await StateStore.open(file);
  const project = store.createProject("앱", directory, "engine-session-repo-key", "main");
  const taskId = store.createDiscussion(project, "원래 요청 전문");
  store.recordPreparedExecution(taskId, 0, join(directory, "worktree"));
  store.saveEngineSession(taskId,{engine:"omp",sessionFile:"/tmp/session.jsonl",cwd:"/tmp/work",phase:"execution"});
  store.close();

  const reopened = await StateStore.open(file);
  assert.deepEqual(reopened.getEngineSession(taskId),{engine:"omp",sessionFile:"/tmp/session.jsonl",cwd:"/tmp/work",phase:"execution"});
  assert.ok(reopened.listRecoverableTaskIds().includes(taskId));
  reopened.close();
});
