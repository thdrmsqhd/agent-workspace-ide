import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type RecoveryAction = "resume_wait" | "verify_side_effect" | "preserve" | "retry_read" | "manual_attention";

export interface RecoveryInput {
  readonly runState: "idle" | "running" | "waiting_input" | "reconnecting" | "stopping" | "paused" | "failed";
  readonly integrationState: "none" | "awaiting_approval" | "queued" | "preparing" | "conflicted" | "merging" | "merged" | "pushing" | "pr_pending" | "done" | "failed" | "unknown";
  readonly operationStates: readonly ("accepted" | "running" | "succeeded" | "failed" | "unknown")[];
}

export function recoveryPlan(input: RecoveryInput): RecoveryAction[] {
  const result = new Set<RecoveryAction>();
  if (["running","waiting_input","reconnecting","stopping"].includes(input.runState)) result.add("resume_wait");
  if (["merging","pushing","pr_pending","unknown"].includes(input.integrationState) || input.operationStates.includes("unknown")) result.add("verify_side_effect");
  if (input.runState === "failed" || input.integrationState === "failed" || input.integrationState === "conflicted") result.add("manual_attention");
  result.add("preserve");
  return [...result];
}

const defaultSeconds = [1,2,4,8,15] as const;
export function retrySchedule(jitter: readonly number[] = [0,0,0,0,0]): number[] {
  return defaultSeconds.map((seconds,index) => {
    const factor = jitter[index] ?? 0;
    if (factor < -1 || factor > 1) throw new Error("jitter 값은 -1~1 범위여야 합니다.");
    return Math.round(seconds * 1000 * (1 + factor * 0.2));
  });
}

export function canAutoRetry(kind: "read" | "side_effect" | "unknown"): boolean {
  return kind === "read";
}

export interface DiagnosticRecord {
  readonly errorCode: string;
  readonly occurredAt: string;
  readonly taskId?: string;
  readonly requestId?: string;
  readonly operationId?: string;
  readonly engineVersion?: string;
  readonly exitCode?: number | null;
  readonly stage?: string;
  readonly logFiles?: readonly string[];
}

export async function exportDiagnostics(outputDirectory: string, records: readonly DiagnosticRecord[]): Promise<string> {
  await mkdir(outputDirectory, { recursive:true });
  const sanitized = records.map((record) => ({
    errorCode:record.errorCode,occurredAt:record.occurredAt,
    ...(record.taskId?{taskId:record.taskId}:{}),
    ...(record.requestId?{requestId:record.requestId}:{}),
    ...(record.operationId?{operationId:record.operationId}:{}),
    ...(record.engineVersion?{engineVersion:record.engineVersion}:{}),
    ...(record.exitCode!==undefined?{exitCode:record.exitCode}:{}),
    ...(record.stage?{stage:record.stage}:{}),
    logFiles:[...(record.logFiles ?? [])],
  }));
  const path=join(outputDirectory,"diagnostics.json");
  await writeFile(path,JSON.stringify({version:1,records:sanitized},null,2)+"\n",{encoding:"utf8"});
  return path;
}

export interface ShutdownHooks {
  persistUiState(): Promise<void>;
  stopOwnedProcesses(): Promise<void>;
  markCleanShutdown(): Promise<void>;
}

export async function gracefulShutdown(hooks: ShutdownHooks): Promise<void> {
  // dirty buffer/초안 저장 실패 시 프로세스를 먼저 죽이지 않는다.
  await hooks.persistUiState();
  await hooks.stopOwnedProcesses();
  await hooks.markCleanShutdown();
}

export interface ProcessIdentity {
  readonly pid:number;
  readonly startToken:string;
}
export function sameProcessIdentity(recorded: ProcessIdentity, observed: ProcessIdentity | undefined): boolean {
  return observed !== undefined && recorded.pid === observed.pid && recorded.startToken === observed.startToken;
}
