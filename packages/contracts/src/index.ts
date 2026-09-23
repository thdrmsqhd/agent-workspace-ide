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
