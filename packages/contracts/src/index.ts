/** 앱 내부 계약의 최소 공통 봉투. 세부 payload와 검증기는 IMP-05에서 작성한다. */
export interface AppError {
  code: string;
  message: string;
  retryable: boolean;
  operationId?: string;
  details?: Record<string, unknown>;
}

export interface Command<T> {
  apiVersion: 1;
  requestId: string;
  method: string;
  taskId?: string;
  expectedRevision?: number;
  payload: T;
}

export type Reply<T> =
  | { requestId: string; status: "completed"; revision?: number; data: T }
  | { requestId: string; status: "accepted"; operationId: string }
  | { requestId: string; status: "rejected"; error: AppError };

export interface Event<T> {
  apiVersion: 1;
  eventId: string;
  sequence: number;
  taskId?: string;
  type: string;
  occurredAt: string;
  payload: T;
}

export const commandMethods = [
  "project.register", "project.updateSettings", "discussion.create", "discussion.send",
  "task.start", "task.send", "queue.update", "queue.delete", "task.abort",
  "task.resume", "input.respond", "attachment.add", "attachment.remove",
  "import.preview", "import.execute", "task.review", "integration.approve",
  "integration.retry", "conflict.continue", "task.cancel", "task.deletePreview",
  "task.delete", "process.start", "process.stop", "view.save", "app.shutdown",
  "file.save", "snapshot.create", "settings.apply", "extension.install",
  "task.createFollowup", "project.relocate", "file.change",
] as const;

export type CommandMethod = (typeof commandMethods)[number];
export type DeliveryMode = "immediate" | "queued";

/** IPC 경계의 봉투만 검증한다. 개별 명령 payload는 구현 시 별도 검사한다. */
export function parseCommandEnvelope(value: unknown): Command<Record<string, unknown>> & { method: CommandMethod } {
  if (!isRecord(value) || !hasOnly(value, ["apiVersion", "requestId", "method", "taskId", "expectedRevision", "payload"])) {
    throw validationError("명령 봉투에 알 수 없는 필드가 있거나 형식이 올바르지 않습니다.");
  }
  if (value.apiVersion !== 1 || !isUuid(value.requestId) ||
      typeof value.method !== "string" || !commandMethods.includes(value.method as CommandMethod) ||
      !isRecord(value.payload) ||
      (value.taskId !== undefined && !isUuid(value.taskId)) ||
      (value.expectedRevision !== undefined && !isRevision(value.expectedRevision))) {
    throw validationError("명령 봉투의 버전, ID, 메서드 또는 revision이 올바르지 않습니다.");
  }
  return value as unknown as Command<Record<string, unknown>> & { method: CommandMethod };
}

export type QueueCommand =
  | Command<{ text: string; attachmentIds: string[]; delivery: DeliveryMode }> & { method: "task.send"; taskId: string; expectedRevision: number }
  | Command<{ messageId: string; text: string; attachmentIds: string[] }> & { method: "queue.update"; taskId: string; expectedRevision: number }
  | Command<{ messageId: string }> & { method: "queue.delete"; taskId: string; expectedRevision: number }
  | Command<{ reason: "user" | "shutdown" }> & { method: "task.abort"; taskId: string }
  | Command<{ text?: string; attachmentIds?: string[] }> & { method: "task.resume"; taskId: string; expectedRevision: number };

/** CMD-06~10의 큐·제어 payload. 다른 명령에는 이 검증기를 적용하지 않는다. */
export function parseQueueCommand(value: unknown): QueueCommand {
  const command = parseCommandEnvelope(value);
  if (!command.taskId ||
      (command.method !== "task.abort" && !isRevision(command.expectedRevision))) {
    throw validationError("작업 ID 또는 필요한 revision이 없습니다.");
  }
  const p = command.payload;
  switch (command.method) {
    case "task.send":
      if (!hasOnly(p, ["text", "attachmentIds", "delivery"]) ||
          !isMessage(p.text, p.attachmentIds) ||
          (p.delivery !== "immediate" && p.delivery !== "queued")) break;
      return command as unknown as QueueCommand;
    case "queue.update":
      if (!hasOnly(p, ["messageId", "text", "attachmentIds"]) ||
          !isUuid(p.messageId) || !isMessage(p.text, p.attachmentIds)) break;
      return command as unknown as QueueCommand;
    case "queue.delete":
      if (!hasOnly(p, ["messageId"]) || !isUuid(p.messageId)) break;
      return command as unknown as QueueCommand;
    case "task.abort":
      if (!hasOnly(p, ["reason"]) || (p.reason !== "user" && p.reason !== "shutdown")) break;
      return command as unknown as QueueCommand;
    case "task.resume":
      if (!hasOnly(p, ["text", "attachmentIds"]) ||
          (p.text !== undefined && typeof p.text !== "string") ||
          (p.attachmentIds !== undefined && !isUuidArray(p.attachmentIds)) ||
          ((p.text !== undefined || p.attachmentIds !== undefined) &&
           !isMessage(p.text ?? "", p.attachmentIds ?? []))) break;
      return command as unknown as QueueCommand;
    default:
      throw validationError("이 명령은 큐·제어 명령이 아닙니다.");
  }
  throw validationError("큐·제어 명령의 입력이 올바르지 않습니다.");
}

export function validationError(message: string): AppError {
  return { code: "E_VALIDATION", message, retryable: false };
}

export function isUuid(value: unknown): value is string {
  return typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export function isRevision(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOnly(record: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(record).every((key) => allowed.includes(key));
}

function isUuidArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isUuid);
}

function isMessage(text: unknown, attachmentIds: unknown): boolean {
  return typeof text === "string" && isUuidArray(attachmentIds) &&
    (text.trim().length > 0 || (attachmentIds as string[]).length > 0);
}
