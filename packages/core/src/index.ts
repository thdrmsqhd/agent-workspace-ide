import type { AppError } from "@awi/contracts";
export { decideAction } from "./policy.js";
export type { Action, ActionApproval, PolicySnapshot, Decision, ExecutionMode } from "./policy.js";

export type Phase = "discussion" | "provisioning" | "execution" | "review" | "archived";
export type RunState = "idle" | "running" | "waiting_input" | "reconnecting" | "stopping" | "paused" | "failed";
export type QueueState = "queued" | "dispatching" | "accepted" | "finished" | "failed" | "unknown" | "deleted";
export type IntegrationState = "none" | "awaiting_approval" | "queued" | "preparing" | "conflicted" | "merging" | "merged" | "pushing" | "pr_pending" | "done" | "failed" | "unknown";

export interface QueuedMessage {
  readonly id: string;
  readonly text: string;
  readonly attachmentIds: readonly string[];
  readonly revision: number;
  readonly state: QueueState;
}

/** 영속성 없는 단일 작업 스냅샷. 호출자는 결과를 한 트랜잭션에서 저장해야 한다. */
export interface TaskQueue {
  readonly taskId: string;
  readonly phase: Phase;
  readonly runState: RunState;
  readonly integrationState: IntegrationState;
  readonly queueMode: "enabled" | "paused";
  readonly revision: number;
  readonly messages: readonly QueuedMessage[];
}

export class DomainError extends Error {
  constructor(public readonly code: "E_STATE" | "E_CAPACITY" | "E_REVISION_CONFLICT" | "E_UNKNOWN_OUTCOME", message: string) {
    super(message);
    this.name = "DomainError";
  }

  toAppError(): AppError {
    return { code: this.code, message: this.message, retryable: false };
  }
}

function revision(actual: number, expected: number): void {
  if (actual !== expected) throw new DomainError("E_REVISION_CONFLICT", "작업 상태가 변경되었습니다. 최신 상태를 확인해 주세요.");
}

function editable(task: TaskQueue): void {
  if (task.phase !== "execution" || ["merging", "merged", "pushing", "pr_pending", "done", "preparing", "conflicted", "unknown"].includes(task.integrationState)) {
    throw new DomainError("E_STATE", "현재 작업에는 대기 지시를 변경할 수 없습니다.");
  }
}

export function enqueue(task: TaskQueue, expectedRevision: number, message: Omit<QueuedMessage, "state" | "revision">): TaskQueue {
  revision(task.revision, expectedRevision);
  editable(task);
  if (task.messages.some((item) => item.id === message.id)) {
    throw new DomainError("E_STATE", "같은 ID의 지시가 이미 있습니다.");
  }
  if (!message.text.trim() && message.attachmentIds.length === 0) {
    throw new DomainError("E_STATE", "지시 내용 또는 첨부가 필요합니다.");
  }
  return { ...task, revision: task.revision + 1, messages: [...task.messages, { ...message, attachmentIds: [...message.attachmentIds], revision: 0, state: "queued" }] };
}

export function updateQueued(task: TaskQueue, messageId: string, expectedMessageRevision: number, text: string, attachmentIds: readonly string[]): TaskQueue {
  editable(task);
  const item = task.messages.find((message) => message.id === messageId);
  if (!item) throw new DomainError("E_STATE", "대기 지시가 없습니다.");
  revision(item.revision, expectedMessageRevision);
  if (item.state !== "queued") throw new DomainError("E_STATE", "전달이 시작된 지시는 수정할 수 없습니다.");
  if (!text.trim() && attachmentIds.length === 0) throw new DomainError("E_STATE", "지시 내용 또는 첨부가 필요합니다.");
  return { ...task, revision: task.revision + 1, messages: task.messages.map((message) => message.id === messageId ? { ...message, text, attachmentIds: [...attachmentIds], revision: message.revision + 1 } : message) };
}

export function deleteQueued(task: TaskQueue, messageId: string, expectedMessageRevision: number): TaskQueue {
  editable(task);
  const item = task.messages.find((message) => message.id === messageId);
  if (!item) throw new DomainError("E_STATE", "대기 지시가 없습니다.");
  revision(item.revision, expectedMessageRevision);
  if (item.state !== "queued") throw new DomainError("E_STATE", "전달이 시작된 지시는 삭제할 수 없습니다.");
  return { ...task, revision: task.revision + 1, messages: task.messages.map((message) => message.id === messageId ? { ...message, state: "deleted", revision: message.revision + 1 } : message) };
}

/** 엔진 호출 전 선점. 결과 스냅샷을 영속화한 다음에만 외부 호출한다. */
export function claimNext(task: TaskQueue): { task: TaskQueue; message?: QueuedMessage } {
  editable(task);
  if (task.queueMode !== "enabled" || task.runState !== "idle" || task.messages.some((message) => message.state === "dispatching" || message.state === "unknown")) {
    return { task };
  }
  const next = task.messages.find((message) => message.state === "queued");
  if (!next) return { task };
  const claimed = { ...next, state: "dispatching" as const, revision: next.revision + 1 };
  return {
    task: { ...task, revision: task.revision + 1, messages: task.messages.map((message) => message.id === next.id ? claimed : message) },
    message: claimed,
  };
}

export function markUnknown(task: TaskQueue, messageId: string): TaskQueue {
  const current = task.messages.find((message) => message.id === messageId);
  if (!current || current.state !== "dispatching") throw new DomainError("E_STATE", "전달 중인 지시가 아닙니다.");
  return { ...task, queueMode: "paused", runState: "paused", revision: task.revision + 1, messages: task.messages.map((message) => message.id === messageId ? { ...message, state: "unknown", revision: message.revision + 1 } : message) };
}

export function abort(task: TaskQueue): TaskQueue {
  if ((task.runState === "paused" || task.runState === "stopping") && task.queueMode === "paused") return task;
  if (!["running", "waiting_input", "reconnecting", "stopping"].includes(task.runState)) throw new DomainError("E_STATE", "중단할 실행이 없습니다.");
  // 실제 프로세스 종료 확인 전에는 paused로 표시하지 않는다.
  return { ...task, runState: "stopping", queueMode: "paused", revision: task.revision + 1 };
}

export function confirmStopped(task: TaskQueue): TaskQueue {
  if (task.runState !== "stopping") throw new DomainError("E_STATE", "중단 처리 중인 작업이 아닙니다.");
  return { ...task, runState: "paused", revision: task.revision + 1 };
}

export function resume(task: TaskQueue, expectedRevision: number): TaskQueue {
  revision(task.revision, expectedRevision);
  editable(task);
  if (task.runState !== "paused") throw new DomainError("E_STATE", "중단된 작업만 재개할 수 있습니다.");
  if (task.messages.some((message) => message.state === "unknown" || message.state === "dispatching")) {
    throw new DomainError("E_UNKNOWN_OUTCOME", "결과가 불명확한 지시를 먼저 확인해야 합니다.");
  }
  return { ...task, runState: "running", queueMode: "enabled", revision: task.revision + 1 };
}

/** 12개 메인 실행 제한. paused 작업은 점유하지 않으며 동일 작업 재획득은 멱등이다. */
export function acquireSlot(activeTaskIds: ReadonlySet<string>, taskId: string): Set<string> {
  if (activeTaskIds.has(taskId)) return new Set(activeTaskIds);
  if (activeTaskIds.size >= 12) throw new DomainError("E_CAPACITY", "동시 실행 작업 한도에 도달했습니다.");
  return new Set([...activeTaskIds, taskId]);
}

export function releaseSlot(activeTaskIds: ReadonlySet<string>, taskId: string): Set<string> {
  const remaining = new Set(activeTaskIds);
  remaining.delete(taskId);
  return remaining;
}

export function cancelTask(task: TaskQueue): TaskQueue {
  if (task.integrationState === "merging" || task.integrationState === "pushing" || task.integrationState === "pr_pending") {
    throw new DomainError("E_STATE", "외부 반영 결과를 확인하기 전에는 작업을 취소할 수 없습니다.");
  }
  if (task.phase === "archived") return task;
  return { ...task, runState: task.runState === "idle" ? "paused" : task.runState, queueMode: "paused", revision: task.revision + 1 };
}

export function archiveTask(task: TaskQueue): TaskQueue {
  if (["running","waiting_input","reconnecting","stopping"].includes(task.runState)) {
    throw new DomainError("E_STATE", "실행 중인 작업은 보관할 수 없습니다.");
  }
  if (!["none","done","failed"].includes(task.integrationState)) {
    throw new DomainError("E_STATE", "반영 상태를 먼저 확인해야 합니다.");
  }
  return { ...task, phase: "archived", queueMode: "paused", revision: task.revision + 1 };
}
