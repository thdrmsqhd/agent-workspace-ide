import { createHash, randomUUID } from "node:crypto";
import { mkdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { isUuid, parseQueueCommand, type QueueCommand } from "@awi/contracts";
import {
  abort, claimNext, confirmStopped, deleteQueued, enqueue, markUnknown,
  resume, updateQueued, type QueuedMessage, type TaskQueue,
} from "@awi/core";
import { initialSchema, runtimeSchema, viewSchema } from "./schema.js";

type Row = Record<string, unknown>;
type StoredResult = { operationId: string; task: TaskQueue; messageId?: string };

export interface SavedDraft {
  scope: "project" | "task";
  ownerId: string;
  text: string;
  attachmentIds: string[];
  revision: number;
}

export interface SavedView {
  taskId?: string;
  layout: Record<string, unknown>;
  tabs: unknown[];
  cursors: unknown[];
  scroll: Record<string, unknown>;
  revision: number;
}

function digest(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable((value as Row)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function requireRow(row: Row | undefined, kind: string): Row {
  if (!row) throw new Error(`${kind} 항목을 찾지 못했습니다.`);
  return row;
}

/** 동기 SQLite API는 단일 백엔드 연결에서만 사용한다. UI 스레드에서 직접 호출하지 않는다. */
export class StateStore {
  private constructor(private readonly db: DatabaseSync, private readonly filename: string) {}

  static async open(filename: string): Promise<StateStore> {
    await mkdir(dirname(filename), { recursive: true });
    const existed = await stat(filename).then(() => true, () => false);
    const db = new DatabaseSync(filename, { timeout: 5000 });
    const store = new StateStore(db, filename);
    try {
      db.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;");
      if ((db.prepare("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check !== "ok") {
        throw new Error("DB 무결성 검사에 실패했습니다. 원본 DB를 보존하고 복구해야 합니다.");
      }
      await store.migrate(existed);
      store.recoverInterrupted();
      return store;
    } catch (error) {
      db.close();
      throw error;
    }
  }

  private async migrate(existed: boolean): Promise<void> {
    const migrationTable = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_migrations'").get();
    const otherTables = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name <> 'schema_migrations'").all();
    if (!migrationTable && otherTables.length) throw new Error("알 수 없는 기존 DB 스키마입니다. 원본을 보존하고 수동으로 확인해 주세요.");
    const migrations = [initialSchema, viewSchema, runtimeSchema];
    let applied = 0;
    if (migrationTable) {
      const rows = this.db.prepare("SELECT id, checksum FROM schema_migrations ORDER BY id").all() as { id: number; checksum: string }[];
      for (const [index, row] of rows.entries()) {
        if (index >= migrations.length || row.id !== index + 1 || row.checksum !== digest(migrations[index]!)) {
          throw new Error("지원하지 않거나 변경된 DB 마이그레이션입니다. 원본 DB를 보존했습니다.");
        }
      }
      applied = rows.length;
    }
    if (existed && applied > 0 && applied < migrations.length) await this.backupSnapshot();
    for (let index = applied; index < migrations.length; index++) {
      this.db.exec("BEGIN IMMEDIATE");
      try {
        this.db.exec(migrations[index]!);
        this.db.prepare("INSERT INTO schema_migrations(id,checksum,applied_at) VALUES(?,?,?)")
          .run(index + 1, digest(migrations[index]!), new Date().toISOString());
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    }
  }

  /** WAL이 있는 DB를 파일 하나만 복사하지 않고 온라인 백업한다. */
  async backupSnapshot(): Promise<string> {
    const target = join(dirname(this.filename), `state-backup-${Date.now()}-${randomUUID()}.sqlite`);
    await backup(this.db, target);
    return target;
  }

  private transaction<T>(action: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = action();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /** 경로·저장소 동일성 검증은 등록 서비스의 책임이다. */
  createProject(name: string, repoPath: string, repoKey: string, defaultBranch: string): string {
    const id = randomUUID();
    this.db.prepare("INSERT INTO projects(id,name,repo_path,repo_key,default_branch,created_at) VALUES(?,?,?,?,?,?)")
      .run(id, name, repoPath, repoKey, defaultBranch, new Date().toISOString());
    return id;
  }



  listProjects(): Array<{ id: string; name: string; createdAt: string }> {
    return (this.db.prepare("SELECT id,name,created_at FROM projects ORDER BY created_at,id").all() as Row[])
      .map((row) => ({ id: row.id as string, name: row.name as string, createdAt: row.created_at as string }));
  }

  listTasks(): Array<{ id: string; projectId: string; originalPrompt: string; phase: string; runState: string; disposition: string; worktreePath?: string; createdAt: string }> {
    return (this.db.prepare("SELECT id,project_id,original_prompt,phase,run_state,disposition,worktree_path,created_at FROM tasks ORDER BY created_at,id").all() as Row[])
      .map((row) => ({
        id: row.id as string,
        projectId: row.project_id as string,
        originalPrompt: row.original_prompt as string,
        phase: row.phase as string,
        runState: row.run_state as string,
        disposition: row.disposition as string,
        ...(typeof row.worktree_path === "string" ? { worktreePath: row.worktree_path } : {}),
        createdAt: row.created_at as string,
      }));
  }

  getProjectInfo(projectId: string): { id: string; name: string; repoPath: string; repoKey: string; defaultBranch: string; revision: number } {
    const row = requireRow(this.db.prepare("SELECT id,name,repo_path,repo_key,default_branch,revision FROM projects WHERE id=?").get(projectId) as Row | undefined, "프로젝트");
    return { id: row.id as string, name: row.name as string, repoPath: row.repo_path as string, repoKey: row.repo_key as string,
      defaultBranch: row.default_branch as string, revision: row.revision as number };
  }

  findProjectByRepoKey(repoKey: string): { id: string; name: string; repoPath: string; repoKey: string; defaultBranch: string; revision: number } | undefined {
    const row = this.db.prepare("SELECT id,name,repo_path,repo_key,default_branch,revision FROM projects WHERE repo_key=?").get(repoKey) as Row | undefined;
    return row ? { id: row.id as string, name: row.name as string, repoPath: row.repo_path as string, repoKey: row.repo_key as string,
      defaultBranch: row.default_branch as string, revision: row.revision as number } : undefined;
  }

  getTaskInfo(taskId: string): { id: string; projectId: string; originalPrompt: string; phase: string; runState: string; integrationState: string; disposition: string; worktreePath?: string; revision: number } {
    const row = requireRow(this.db.prepare("SELECT id,project_id,original_prompt,phase,run_state,integration_state,disposition,worktree_path,revision FROM tasks WHERE id=?").get(taskId) as Row | undefined, "작업");
    return { id: row.id as string, projectId: row.project_id as string, originalPrompt: row.original_prompt as string,
      phase: row.phase as string, runState: row.run_state as string, integrationState: row.integration_state as string,
      disposition: row.disposition as string, ...(typeof row.worktree_path === "string" ? { worktreePath: row.worktree_path } : {}), revision: row.revision as number };
  }

  setTaskRunState(taskId: string, runState: TaskQueue["runState"], queueMode?: TaskQueue["queueMode"]): TaskQueue {
    return this.transaction(() => {
      const before = this.getTaskQueue(taskId);
      const nextQueueMode = queueMode ?? before.queueMode;
      const changed = this.db.prepare("UPDATE tasks SET run_state=?,queue_mode=?,revision=revision+1,updated_at=? WHERE id=? AND revision=?")
        .run(runState, nextQueueMode, new Date().toISOString(), taskId, before.revision);
      if (changed.changes !== 1) throw new Error("E_REVISION_CONFLICT: 작업 상태가 변경되었습니다.");
      this.appendEvent(taskId, "task.changed", { taskId, revision: before.revision + 1, runState });
      return this.getTaskQueue(taskId);
    });
  }

  recordImmediateMessage(taskId: string, role: "user" | "assistant" | "system", content: string, attachmentIds: readonly string[] = []): string {
    if (!content.trim() && attachmentIds.length === 0) throw new Error("메시지 내용 또는 첨부가 필요합니다.");
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db.prepare("INSERT INTO messages(id,task_id,role,content,attachment_ids_json,delivery_mode,queue_state,revision,created_at,updated_at) VALUES(?,?,?,?,?,'immediate','none',0,?,?)")
      .run(id, taskId, role, content, JSON.stringify(attachmentIds), now, now);
    this.appendEvent(taskId, "message.created", { taskId, messageId: id, role });
    return id;
  }

  markDispatchAccepted(taskId: string, messageId: string): TaskQueue {
    return this.transaction(() => {
      const changed = this.db.prepare("UPDATE messages SET queue_state='accepted',revision=revision+1,updated_at=? WHERE id=? AND task_id=? AND queue_state='dispatching'")
        .run(new Date().toISOString(), messageId, taskId);
      if (changed.changes !== 1) throw new Error("E_REVISION_CONFLICT: 지시 전달 상태가 변경되었습니다.");
      this.db.prepare("UPDATE operations SET state='succeeded' WHERE scope_key=? AND method='queue.dispatch' AND payload_hash=? AND state='accepted'")
        .run(taskId, digest(messageId));
      this.appendEvent(taskId, "queue.changed", { taskId, messageId, state: "accepted" });
      return this.getTaskQueue(taskId);
    });
  }

  markDispatchFinished(taskId: string, messageId: string): TaskQueue {
    return this.transaction(() => {
      const changed = this.db.prepare("UPDATE messages SET queue_state='finished',revision=revision+1,updated_at=? WHERE id=? AND task_id=? AND queue_state='accepted'")
        .run(new Date().toISOString(), messageId, taskId);
      if (changed.changes !== 1) throw new Error("수락된 지시가 아니거나 이미 완료되었습니다.");
      this.appendEvent(taskId, "queue.changed", { taskId, messageId, state: "finished" });
      return this.getTaskQueue(taskId);
    });
  }

  createDiscussion(projectId: string, originalPrompt: string): string {
    if (!originalPrompt.trim()) throw new Error("원래 요청이 비어 있습니다.");
    return this.transaction(() => {
      const id = randomUUID();
      const now = new Date().toISOString();
      this.db.prepare("INSERT INTO tasks(id,project_id,original_prompt,phase,run_state,created_at,updated_at) VALUES(?,?,?,'discussion','idle',?,?)")
        .run(id, projectId, originalPrompt, now, now);
      this.appendEvent(id, "task.changed", { taskId: id, revision: 0 });
      return id;
    });
  }

  /** 외부의 워크트리 준비가 성공한 뒤에만 호출한다. 이 메서드는 워크트리를 만들지 않는다. */
  recordPreparedExecution(taskId: string, expectedRevision: number, worktreePath: string): TaskQueue {
    if (!worktreePath.trim()) throw new Error("준비된 워크트리 경로가 필요합니다.");
    return this.transaction(() => {
      const task = this.getTaskQueue(taskId);
      if (task.phase !== "discussion" || task.revision !== expectedRevision) throw new Error("작업 시작 상태 또는 revision이 맞지 않습니다.");
      const result = this.db.prepare("UPDATE tasks SET phase='execution', worktree_path=?, revision=revision+1, updated_at=? WHERE id=? AND phase='discussion' AND revision=?")
        .run(worktreePath, new Date().toISOString(), taskId, expectedRevision);
      if (result.changes !== 1) throw new Error("작업 준비 결과를 저장할 수 없습니다.");
      this.appendEvent(taskId, "task.changed", { taskId, revision: task.revision + 1 });
      return this.getTaskQueue(taskId);
    });
  }


  setTaskDisposition(taskId: string, disposition: "completed" | "cancelled"): void {
    this.transaction(() => {
      const task = this.getTaskInfo(taskId);
      if (["running","waiting_input","reconnecting","stopping"].includes(task.runState)) {
        throw new Error("실행 중인 작업은 먼저 중단해야 합니다.");
      }
      const changed = this.db.prepare("UPDATE tasks SET disposition=?,queue_mode='paused',revision=revision+1,updated_at=? WHERE id=? AND revision=?")
        .run(disposition, new Date().toISOString(), taskId, task.revision);
      if (changed.changes !== 1) throw new Error("E_REVISION_CONFLICT: 작업 상태가 변경되었습니다.");
      this.appendEvent(taskId, "task.changed", { taskId, disposition });
    });
  }

  archiveTask(taskId: string): void {
    this.transaction(() => {
      const task = this.getTaskInfo(taskId);
      if (task.disposition === "active") throw new Error("완료 또는 취소된 작업만 보관할 수 있습니다.");
      if (["running","waiting_input","reconnecting","stopping"].includes(task.runState)) throw new Error("실행 중인 작업은 보관할 수 없습니다.");
      const changed = this.db.prepare("UPDATE tasks SET phase='archived',queue_mode='paused',revision=revision+1,updated_at=? WHERE id=? AND revision=?")
        .run(new Date().toISOString(), taskId, task.revision);
      if (changed.changes !== 1) throw new Error("E_REVISION_CONFLICT: 작업 상태가 변경되었습니다.");
      this.appendEvent(taskId, "task.changed", { taskId, phase: "archived" });
    });
  }

  getTaskQueue(taskId: string): TaskQueue {
    const row = requireRow(this.db.prepare("SELECT id,phase,run_state,integration_state,queue_mode,revision FROM tasks WHERE id=?").get(taskId) as Row | undefined, "작업");
    const messages = this.db.prepare("SELECT id,content,attachment_ids_json,revision,queue_state FROM messages WHERE task_id=? AND delivery_mode='queued' ORDER BY queue_position").all(taskId) as Row[];
    return {
      taskId: row.id as string, phase: row.phase as TaskQueue["phase"], runState: row.run_state as TaskQueue["runState"],
      integrationState: row.integration_state as TaskQueue["integrationState"],
      queueMode: row.queue_mode as TaskQueue["queueMode"], revision: row.revision as number,
      messages: messages.map((item) => ({
        id: item.id as string, text: item.content as string, attachmentIds: JSON.parse(item.attachment_ids_json as string) as string[],
        revision: item.revision as number, state: item.queue_state as QueuedMessage["state"],
      })),
    };
  }

  getDraft(scope: "project" | "task", ownerId: string): SavedDraft | undefined {
    const key = scope === "project" ? "project_id" : "task_id";
    const row = this.db.prepare(`SELECT text,attachment_ids_json,revision FROM drafts WHERE scope=? AND ${key}=?`).get(scope, ownerId) as Row | undefined;
    if (!row) return undefined;
    return { scope, ownerId, text: row.text as string,
      attachmentIds: JSON.parse(row.attachment_ids_json as string) as string[], revision: row.revision as number };
  }

  saveDraft(draft: SavedDraft, expectedRevision: number): SavedDraft {
    if (!isUuid(draft.ownerId) || !draft.attachmentIds.every(isUuid)) throw new Error("초안 참조 ID가 올바르지 않습니다.");
    return this.transaction(() => {
      const before = this.getDraft(draft.scope, draft.ownerId);
      if ((before?.revision ?? 0) !== expectedRevision) throw new Error("E_REVISION_CONFLICT: 초안이 변경되었습니다.");
      const key = draft.scope === "project" ? "project_id" : "task_id";
      const value = JSON.stringify(draft.attachmentIds);
      if (before) {
        const updated = this.db.prepare(`UPDATE drafts SET text=?,attachment_ids_json=?,revision=revision+1 WHERE scope=? AND ${key}=? AND revision=?`)
          .run(draft.text, value, draft.scope, draft.ownerId, expectedRevision);
        if (updated.changes !== 1) throw new Error("E_REVISION_CONFLICT: 초안이 변경되었습니다.");
      } else {
        this.db.prepare(`INSERT INTO drafts(id,scope,${key},text,attachment_ids_json) VALUES(?,?,?,?,?)`)
          .run(randomUUID(), draft.scope, draft.ownerId, draft.text, value);
      }
      return this.getDraft(draft.scope, draft.ownerId)!;
    });
  }

  getView(taskId?: string): SavedView | undefined {
    const id = taskId ?? "global";
    const row = this.db.prepare("SELECT layout_json,tabs_json,cursors_json,scroll_json,revision FROM view_states WHERE id=?").get(id) as Row | undefined;
    if (!row) return undefined;
    return { ...(taskId ? { taskId } : {}), layout: JSON.parse(row.layout_json as string) as Record<string, unknown>,
      tabs: JSON.parse(row.tabs_json as string) as unknown[], cursors: JSON.parse(row.cursors_json as string) as unknown[],
      scroll: JSON.parse(row.scroll_json as string) as Record<string, unknown>, revision: row.revision as number };
  }

  saveView(view: SavedView, expectedRevision: number): SavedView {
    if (view.taskId !== undefined && !isUuid(view.taskId)) throw new Error("보기 작업 ID가 올바르지 않습니다.");
    if (!view.layout || typeof view.layout !== "object" || Array.isArray(view.layout) ||
        !view.scroll || typeof view.scroll !== "object" || Array.isArray(view.scroll) ||
        !Array.isArray(view.tabs) || !Array.isArray(view.cursors)) throw new Error("보기 형식이 올바르지 않습니다.");
    return this.transaction(() => {
      const before = this.getView(view.taskId);
      if ((before?.revision ?? 0) !== expectedRevision) throw new Error("E_REVISION_CONFLICT: 화면 상태가 변경되었습니다.");
      const id = view.taskId ?? "global";
      const values = [JSON.stringify(view.layout), JSON.stringify(view.tabs), JSON.stringify(view.cursors), JSON.stringify(view.scroll)];
      if (values.some((value) => value === undefined)) throw new Error("보기 값을 저장할 수 없습니다.");
      if (before) {
        const updated = this.db.prepare("UPDATE view_states SET layout_json=?,tabs_json=?,cursors_json=?,scroll_json=?,revision=revision+1,updated_at=? WHERE id=? AND revision=?")
          .run(...values, new Date().toISOString(), id, expectedRevision);
        if (updated.changes !== 1) throw new Error("E_REVISION_CONFLICT: 화면 상태가 변경되었습니다.");
      } else {
        this.db.prepare("INSERT INTO view_states(id,task_id,layout_json,tabs_json,cursors_json,scroll_json,updated_at) VALUES(?,?,?,?,?,?,?)")
          .run(id, view.taskId ?? null, ...values, new Date().toISOString());
      }
      return this.getView(view.taskId)!;
    });
  }


  saveAttachment(taskId: string | undefined, attachment: { id: string; kind: "file" | "folder" | "image" | "code-selection"; relativePath: string; metadata?: Record<string, unknown> }): void {
    if (!attachment.id.trim() || !attachment.relativePath.trim()) throw new Error("첨부 식별자와 경로가 필요합니다.");
    if (taskId !== undefined && !isUuid(taskId)) throw new Error("첨부 작업 ID가 올바르지 않습니다.");
    this.db.prepare("INSERT OR REPLACE INTO attachments(id,task_id,kind,relative_path,metadata_json,created_at) VALUES(?,?,?,?,?,?)")
      .run(attachment.id, taskId ?? null, attachment.kind, attachment.relativePath, JSON.stringify(attachment.metadata ?? {}), new Date().toISOString());
  }

  listAttachments(taskId: string): Array<{ id: string; kind: string; relativePath: string; metadata: Record<string, unknown> }> {
    return (this.db.prepare("SELECT id,kind,relative_path,metadata_json FROM attachments WHERE task_id=? ORDER BY created_at").all(taskId) as Row[])
      .map((row) => ({ id: row.id as string, kind: row.kind as string, relativePath: row.relative_path as string,
        metadata: JSON.parse(row.metadata_json as string) as Record<string, unknown> }));
  }

  saveSettingsSnapshot(scope: "project" | "task", ownerId: string, settings: object, expectedRevision?: number): number {
    if (!ownerId.trim()) throw new Error("설정 소유자가 필요합니다.");
    const row = this.db.prepare("SELECT revision FROM settings_snapshots WHERE scope=? AND owner_id=?").get(scope, ownerId) as { revision: number } | undefined;
    const revision = row?.revision ?? 0;
    if (expectedRevision !== undefined && expectedRevision !== revision) throw new Error("E_REVISION_CONFLICT: 설정이 변경되었습니다.");
    const now = new Date().toISOString();
    if (!row) {
      this.db.prepare("INSERT INTO settings_snapshots(id,scope,owner_id,revision,settings_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?)")
        .run(randomUUID(), scope, ownerId, 0, JSON.stringify(settings), now, now);
      return 0;
    }
    this.db.prepare("UPDATE settings_snapshots SET revision=revision+1,settings_json=?,updated_at=? WHERE scope=? AND owner_id=? AND revision=?")
      .run(JSON.stringify(settings), now, scope, ownerId, revision);
    return revision + 1;
  }

  getSettingsSnapshot(scope: "project" | "task", ownerId: string): { revision: number; settings: Record<string, unknown> } | undefined {
    const row = this.db.prepare("SELECT revision,settings_json FROM settings_snapshots WHERE scope=? AND owner_id=?").get(scope, ownerId) as Row | undefined;
    return row ? { revision: row.revision as number, settings: JSON.parse(row.settings_json as string) as Record<string, unknown> } : undefined;
  }

  createInputRequest(taskId: string, payload: Record<string, unknown>, expiresAt?: string): string {
    if (!isUuid(taskId)) throw new Error("입력 요청 작업 ID가 올바르지 않습니다.");
    const id = randomUUID();
    this.db.prepare("INSERT INTO input_requests(id,task_id,status,payload_json,expires_at,created_at) VALUES(?,?,'pending',?,?,?)")
      .run(id, taskId, JSON.stringify(payload), expiresAt ?? null, new Date().toISOString());
    this.appendEvent(taskId, "input.requested", { taskId, inputRequestId: id });
    return id;
  }


  getInputRequest(inputRequestId: string): { id: string; taskId: string; status: string; payload: Record<string, unknown>; expiresAt?: string } | undefined {
    const row = this.db.prepare("SELECT id,task_id,status,payload_json,expires_at FROM input_requests WHERE id=?").get(inputRequestId) as Row | undefined;
    if (!row) return undefined;
    return {
      id: row.id as string,
      taskId: row.task_id as string,
      status: row.status as string,
      payload: JSON.parse(row.payload_json as string) as Record<string, unknown>,
      ...(typeof row.expires_at === "string" ? { expiresAt: row.expires_at } : {}),
    };
  }

  respondInputRequest(inputRequestId: string, response: Record<string, unknown>): { taskId: string; status: "answered" } {
    const outcome = this.transaction(() => {
      const row = this.db.prepare("SELECT task_id,status,expires_at FROM input_requests WHERE id=?").get(inputRequestId) as Row | undefined;
      if (!row) throw new Error("입력 요청이 없습니다.");
      if (row.status !== "pending") throw new Error("E_INPUT_CLOSED: 이미 처리된 입력 요청입니다.");
      const taskId = row.task_id as string;
      if (typeof row.expires_at === "string" && Date.parse(row.expires_at) <= Date.now()) {
        const changed = this.db.prepare("UPDATE input_requests SET status='expired' WHERE id=? AND status='pending'").run(inputRequestId);
        if (changed.changes !== 1) throw new Error("E_INPUT_CLOSED: 다른 응답이 먼저 처리되었습니다.");
        this.appendEvent(taskId, "input.expired", { taskId, inputRequestId });
        return { kind: "expired" as const, taskId };
      }
      const changed = this.db.prepare("UPDATE input_requests SET status='answered',response_json=?,answered_at=? WHERE id=? AND status='pending'")
        .run(JSON.stringify(response), new Date().toISOString(), inputRequestId);
      if (changed.changes !== 1) throw new Error("E_INPUT_CLOSED: 다른 응답이 먼저 처리되었습니다.");
      this.appendEvent(taskId, "input.answered", { taskId, inputRequestId });
      return { kind: "answered" as const, taskId };
    });
    if (outcome.kind === "expired") throw new Error("E_INPUT_EXPIRED: 입력 요청이 만료되었습니다.");
    return { taskId: outcome.taskId, status: "answered" };
  }

  listPendingInputRequests(taskId: string): Array<{ id: string; payload: Record<string, unknown>; expiresAt?: string }> {
    const rows = this.db.prepare("SELECT id,payload_json,expires_at FROM input_requests WHERE task_id=? AND status='pending' ORDER BY created_at").all(taskId) as Row[];
    return rows.map((row) => ({ id: row.id as string, payload: JSON.parse(row.payload_json as string) as Record<string, unknown>,
      ...(typeof row.expires_at === "string" ? { expiresAt: row.expires_at } : {}) }));
  }

  saveIntegrationJournal(taskId: string, value: { repoKey: string; targetRef: string; expectedHead?: string; state: string; payload?: Record<string, unknown> }): void {
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO integration_journals(task_id,repo_key,target_ref,expected_head,state,payload_json,updated_at)
      VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(task_id) DO UPDATE SET repo_key=excluded.repo_key,target_ref=excluded.target_ref,expected_head=excluded.expected_head,state=excluded.state,payload_json=excluded.payload_json,updated_at=excluded.updated_at
    `).run(taskId, value.repoKey, value.targetRef, value.expectedHead ?? null, value.state, JSON.stringify(value.payload ?? {}), now);
  }

  getIntegrationJournal(taskId: string): Record<string, unknown> | undefined {
    const row = this.db.prepare("SELECT repo_key,target_ref,expected_head,state,payload_json,updated_at FROM integration_journals WHERE task_id=?").get(taskId) as Row | undefined;
    return row ? { repoKey: row.repo_key, targetRef: row.target_ref, expectedHead: row.expected_head, state: row.state,
      payload: JSON.parse(row.payload_json as string), updatedAt: row.updated_at } : undefined;
  }

  recordProcess(taskId: string, value: { id: string; role: string; pid: number; startToken: string; state: "running" | "exited" | "unknown"; metadata?: Record<string, unknown> }): void {
    this.db.prepare(`
      INSERT INTO process_records(id,task_id,role,pid,start_token,state,metadata_json,updated_at)
      VALUES(?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET state=excluded.state,metadata_json=excluded.metadata_json,updated_at=excluded.updated_at
    `).run(value.id, taskId, value.role, value.pid, value.startToken, value.state, JSON.stringify(value.metadata ?? {}), new Date().toISOString());
  }


  latestArtifact(taskId: string, kind: string): { id: string; location: string; metadata: Record<string, unknown>; createdAt: string } | undefined {
    const row = this.db.prepare("SELECT id,location,metadata_json,created_at FROM artifacts WHERE task_id=? AND kind=? ORDER BY created_at DESC LIMIT 1")
      .get(taskId, kind) as Row | undefined;
    return row ? {
      id: row.id as string,
      location: row.location as string,
      metadata: JSON.parse(row.metadata_json as string) as Record<string, unknown>,
      createdAt: row.created_at as string,
    } : undefined;
  }

  saveArtifact(taskId: string, kind: string, location: string, metadata: Record<string, unknown> = {}): string {
    const id = randomUUID();
    this.db.prepare("INSERT INTO artifacts(id,task_id,kind,location,metadata_json,created_at) VALUES(?,?,?,?,?,?)")
      .run(id, taskId, kind, location, JSON.stringify(metadata), new Date().toISOString());
    return id;
  }

  /** requestId 재사용을 payload 해시로 판별하며 상태·메시지·이벤트·operation을 원자적으로 저장한다. */
  applyQueueCommand(input: unknown): StoredResult {
    const command = parseQueueCommand(input);
    const hash = digest(stable(command));
    return this.transaction(() => {
      const existing = this.db.prepare("SELECT payload_hash,state,result_json FROM operations WHERE request_id=?").get(command.requestId) as Row | undefined;
      if (existing) {
        if (existing.payload_hash !== hash) throw new Error("E_REQUEST_REUSE: 같은 requestId에 다른 명령을 사용할 수 없습니다.");
        if (existing.state !== "succeeded" || !existing.result_json) throw new Error("E_UNKNOWN_OUTCOME: 기존 명령의 결과를 확인해야 합니다.");
        return JSON.parse(existing.result_json as string) as StoredResult;
      }
      const before = this.getTaskQueue(command.taskId);
      const next = this.applyMutation(before, command);
      this.saveMutation(before, next.task);
      const operationId = randomUUID();
      const result: StoredResult = { operationId, task: next.task, ...(next.messageId ? { messageId: next.messageId } : {}) };
      this.db.prepare("INSERT INTO operations(id,request_id,scope_key,method,payload_hash,state,result_json,created_at) VALUES(?,?,?,?,?,'succeeded',?,?)")
        .run(operationId, command.requestId, command.taskId, command.method, hash, JSON.stringify(result), new Date().toISOString());
      this.appendEvent(command.taskId, "queue.changed", { taskId: command.taskId, revision: next.task.revision });
      return result;
    });
  }

  private applyMutation(before: TaskQueue, command: QueueCommand): { task: TaskQueue; messageId?: string } {
    switch (command.method) {
      case "task.send": {
        if (command.payload.delivery !== "queued") throw new Error("즉시 전달은 엔진 연결 후 구현합니다.");
        const id = randomUUID();
        return { task: enqueue(before, command.expectedRevision, { id, text: command.payload.text, attachmentIds: command.payload.attachmentIds }), messageId: id };
      }
      case "queue.update":
        return { task: updateQueued(before, command.payload.messageId, command.expectedRevision, command.payload.text, command.payload.attachmentIds) };
      case "queue.delete":
        return { task: deleteQueued(before, command.payload.messageId, command.expectedRevision) };
      case "task.abort":
        return { task: abort(before) };
      case "task.resume":
        if (command.payload.text || command.payload.attachmentIds?.length) throw new Error("재개 지시 전달은 엔진 연결 후 구현합니다.");
        return { task: resume(before, command.expectedRevision) };
    }
  }

  /** 변경 행 수를 확인해 다른 스냅샷이나 잘못된 상태를 저장하지 않는다. */
  private saveMutation(before: TaskQueue, after: TaskQueue): void {
    if (after.revision !== before.revision) {
      const result = this.db.prepare("UPDATE tasks SET run_state=?,queue_mode=?,revision=?,updated_at=? WHERE id=? AND revision=?")
        .run(after.runState, after.queueMode, after.revision, new Date().toISOString(), before.taskId, before.revision);
      if (result.changes !== 1) throw new Error("E_REVISION_CONFLICT: 작업 상태가 변경되었습니다.");
    }
    for (const item of after.messages) {
      const previous = before.messages.find((message) => message.id === item.id);
      if (!previous) {
        const position = this.db.prepare("SELECT COALESCE(MAX(queue_position),-1)+1 AS position FROM messages WHERE task_id=?").get(before.taskId) as { position: number };
        const now = new Date().toISOString();
        this.db.prepare("INSERT INTO messages(id,task_id,content,attachment_ids_json,delivery_mode,queue_state,queue_position,revision,created_at,updated_at) VALUES(?,?,?,?,'queued',?,?,0,?,?)")
          .run(item.id, before.taskId, item.text, JSON.stringify(item.attachmentIds), item.state, position.position, now, now);
      } else if (previous.revision !== item.revision) {
        const changed = this.db.prepare("UPDATE messages SET content=?,attachment_ids_json=?,queue_state=?,revision=?,updated_at=? WHERE id=? AND revision=? AND queue_state=?")
          .run(item.text, JSON.stringify(item.attachmentIds), item.state, item.revision, new Date().toISOString(), item.id, previous.revision, previous.state);
        if (changed.changes !== 1) throw new Error("E_REVISION_CONFLICT: 대기 지시가 변경되었습니다.");
      }
    }
  }

  /** 선점을 커밋한 뒤에만 호출자가 엔진에 전달해야 한다. */
  claimNextMessage(taskId: string): QueuedMessage | undefined {
    return this.transaction(() => {
      const before = this.getTaskQueue(taskId);
      const claimed = claimNext(before);
      if (!claimed.message) return undefined;
      this.saveMutation(before, claimed.task);
      const id = randomUUID();
      this.db.prepare("INSERT INTO operations(id,request_id,scope_key,method,payload_hash,state,created_at) VALUES(?,?,?,?,?,'accepted',?)")
        .run(id, id, taskId, "queue.dispatch", digest(claimed.message.id), new Date().toISOString());
      this.appendEvent(taskId, "queue.changed", { taskId, revision: claimed.task.revision });
      return claimed.message;
    });
  }

  markDispatchUncertain(taskId: string, messageId: string): TaskQueue {
    return this.transaction(() => {
      const before = this.getTaskQueue(taskId);
      const after = markUnknown(before, messageId);
      this.saveMutation(before, after);
      this.db.prepare("UPDATE operations SET state='unknown' WHERE scope_key=? AND method='queue.dispatch' AND payload_hash=? AND state='accepted'")
        .run(taskId, digest(messageId));
      this.appendEvent(taskId, "queue.changed", { taskId, revision: after.revision });
      return after;
    });
  }

  confirmAbort(taskId: string): TaskQueue {
    return this.transaction(() => {
      const before = this.getTaskQueue(taskId);
      const after = confirmStopped(before);
      this.saveMutation(before, after);
      this.appendEvent(taskId, "task.changed", { taskId, revision: after.revision });
      return after;
    });
  }

  /** 재시작 시 실행을 재생하지 않고 미확인 전달과 부작용을 명시적으로 격리한다. */
  private recoverInterrupted(): void {
    this.transaction(() => {
      const candidates = this.db.prepare("SELECT id FROM tasks WHERE run_state IN ('running','waiting_input','reconnecting','stopping') OR integration_state IN ('merging','pushing','pr_pending') OR id IN (SELECT task_id FROM messages WHERE queue_state IN ('dispatching','accepted'))").all() as { id: string }[];
      for (const { id } of candidates) {
        const before = this.getTaskQueue(id);
        const uncertain = before.messages.some((message) => message.state === "dispatching" || message.state === "accepted");
        this.db.prepare("UPDATE messages SET queue_state='unknown',revision=revision+1,updated_at=? WHERE task_id=? AND queue_state IN ('dispatching','accepted')")
          .run(new Date().toISOString(), id);
        const integration = ["merging", "pushing", "pr_pending"].includes(before.integrationState) ? "unknown" : before.integrationState;
        this.db.prepare("UPDATE tasks SET run_state='paused',queue_mode='paused',integration_state=?,revision=revision+1,updated_at=? WHERE id=?")
          .run(integration, new Date().toISOString(), id);
        this.appendEvent(id, "task.changed", { taskId: id, revision: before.revision + 1, recovery: uncertain ? "unknown" : "paused" });
      }
      this.db.prepare("UPDATE operations SET state='unknown' WHERE state IN ('accepted','running')").run();
      this.db.prepare("UPDATE process_records SET state='unknown',updated_at=? WHERE state='running'").run(new Date().toISOString());
      this.db.prepare("UPDATE integration_journals SET state='unknown',updated_at=? WHERE state IN ('merging','pushing','pr_pending')").run(new Date().toISOString());
    });
  }

  private appendEvent(taskId: string, type: string, payload: object): void {
    this.db.prepare("INSERT INTO events(id,task_id,event_type,payload_json,created_at) VALUES(?,?,?,?,?)")
      .run(randomUUID(), taskId, type, JSON.stringify(payload), new Date().toISOString());
  }

  eventCount(): number {
    return (this.db.prepare("SELECT COUNT(*) AS total FROM events").get() as { total: number }).total;
  }

  close(): void {
    this.db.close();
  }
}
