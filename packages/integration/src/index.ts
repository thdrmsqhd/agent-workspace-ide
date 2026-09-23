import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import type { ActionApproval, PolicySnapshot } from "@awi/core";
import { decideAction } from "@awi/core";
import { inspectRepository } from "@awi/worktrees";

const run = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await run("git", args, { cwd, encoding: "utf8", timeout: 60_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true });
  return stdout.trim();
}

export interface IntegrationRequest {
  readonly taskId: string;
  readonly repoKey: string;
  readonly integrationWorktreePath: string;
  readonly sourceRef: string;
  readonly targetRef: string;
  readonly expectedTargetHead: string;
  readonly policy: PolicySnapshot;
  readonly approval?: ActionApproval;
  readonly commitMessage: string;
}

export type IntegrationResult =
  | { readonly operationId: string; readonly state: "merged"; readonly targetHeadBefore: string; readonly targetHeadAfter: string }
  | { readonly operationId: string; readonly state: "conflicted"; readonly targetHeadBefore: string; readonly files: readonly string[] }
  | { readonly operationId: string; readonly state: "stale"; readonly actualTargetHead: string }
  | { readonly operationId: string; readonly state: "needs_approval"; readonly reason: string };

interface LockState {
  tail: Promise<void>;
}

export class RepositoryIntegrationCoordinator {
  readonly #locks = new Map<string, LockState>();

  async integrate(request: IntegrationRequest): Promise<IntegrationResult> {
    return this.#serial(request.repoKey, () => this.#integrateLocked(request));
  }

  async #serial<T>(repoKey: string, action: () => Promise<T>): Promise<T> {
    const previous = this.#locks.get(repoKey)?.tail ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    this.#locks.set(repoKey, { tail: previous.then(() => gate) });
    await previous;
    try {
      return await action();
    } finally {
      release();
      const current = this.#locks.get(repoKey);
      if (current?.tail === gate) this.#locks.delete(repoKey);
    }
  }

  async #integrateLocked(request: IntegrationRequest): Promise<IntegrationResult> {
    const operationId = randomUUID();
    const decision = decideAction(request.policy, "merge", request.approval);
    if (decision.kind !== "allowed") {
      return { operationId, state: "needs_approval", reason: decision.reason };
    }
    const info = await inspectRepository(request.integrationWorktreePath);
    if (info.repoKey !== request.repoKey) throw new Error("반영 작업대가 요청 저장소와 다릅니다.");
    const status = await git(request.integrationWorktreePath, ["status", "--porcelain=v1"]);
    if (status) throw new Error("반영 작업대가 깨끗하지 않습니다.");

    const targetHead = await git(request.integrationWorktreePath, ["rev-parse", "--verify", `${request.targetRef}^{commit}`]);
    if (targetHead !== request.expectedTargetHead) {
      return { operationId, state: "stale", actualTargetHead: targetHead };
    }

    const currentBranch = await git(request.integrationWorktreePath, ["symbolic-ref", "--quiet", "--short", "HEAD"]).catch(() => "");
    if (currentBranch !== request.targetRef) throw new Error("반영 작업대가 대상 브랜치에 있지 않습니다.");

    try {
      await git(request.integrationWorktreePath, ["merge", "--no-ff", "--no-commit", request.sourceRef]);
    } catch {
      const conflicts = await git(request.integrationWorktreePath, ["diff", "--name-only", "--diff-filter=U"]).catch(() => "");
      if (conflicts) {
        return { operationId, state: "conflicted", targetHeadBefore: targetHead, files: conflicts.split(/\r?\n/u).filter(Boolean) };
      }
      throw new Error("병합 준비에 실패했습니다.");
    }

    const mergeHeadExists = await git(request.integrationWorktreePath, ["rev-parse", "--verify", "-q", "MERGE_HEAD"]).then(Boolean, () => false);
    if (mergeHeadExists) {
      await git(request.integrationWorktreePath, ["-c", "user.name=Agent Workspace IDE", "-c", "user.email=awi@example.invalid", "commit", "-m", request.commitMessage]);
    }
    const after = await git(request.integrationWorktreePath, ["rev-parse", "HEAD"]);
    return { operationId, state: "merged", targetHeadBefore: targetHead, targetHeadAfter: after };
  }
}

export interface CleanupState {
  readonly dirtyWorktree: boolean;
  readonly runningProcesses: number;
  readonly dirtyBuffers: number;
  readonly activeDebuggers: number;
  readonly integrationState: "none" | "done" | "failed" | "unknown" | "conflicted";
}

export function cleanupBlockers(state: CleanupState): string[] {
  const blockers: string[] = [];
  if (state.dirtyWorktree) blockers.push("미반영 Git 변경");
  if (state.runningProcesses > 0) blockers.push("실행 중 프로세스");
  if (state.dirtyBuffers > 0) blockers.push("미저장 편집 버퍼");
  if (state.activeDebuggers > 0) blockers.push("활성 디버거");
  if (!["none", "done"].includes(state.integrationState)) blockers.push(`반영 상태 ${state.integrationState}`);
  return blockers;
}

export type FollowupPlan =
  | { readonly kind: "same-task"; readonly taskId: string }
  | { readonly kind: "linked-task"; readonly previousTaskId: string; readonly baseRef: string };

export function planFollowup(taskId: string, merged: boolean, latestTargetRef: string): FollowupPlan {
  return merged ? { kind: "linked-task", previousTaskId: taskId, baseRef: latestTargetRef } : { kind: "same-task", taskId };
}

export interface CheckResult {
  readonly name: string;
  readonly status: "passed" | "failed" | "not_run";
  readonly detail?: string;
}

export interface ReviewArtifact {
  readonly originalPrompt: string;
  readonly followups: readonly string[];
  readonly summary: string;
  readonly changedFiles: readonly string[];
  readonly checks: readonly CheckResult[];
  readonly urls: readonly string[];
  readonly integrationActions: readonly ("merge" | "push" | "createPR")[];
}

export function createReviewArtifact(value: ReviewArtifact): ReviewArtifact {
  if (!value.originalPrompt.trim()) throw new Error("원래 요청이 필요합니다.");
  if (value.checks.some((item) => !["passed", "failed", "not_run"].includes(item.status))) throw new Error("검증 상태가 올바르지 않습니다.");
  return {
    ...value,
    followups: [...value.followups],
    changedFiles: [...value.changedFiles],
    checks: value.checks.map((item) => ({ ...item })),
    urls: [...value.urls],
    integrationActions: [...value.integrationActions],
  };
}

export async function cleanupWorktree(request: {
  repoPath: string;
  worktreePath: string;
  state: CleanupState;
}): Promise<{ removed: true; preservedBranch: true }> {
  const blockers = cleanupBlockers(request.state);
  if (blockers.length) throw new Error(`워크트리를 정리할 수 없습니다: ${blockers.join(", ")}`);
  const source = await inspectRepository(request.repoPath);
  const target = await inspectRepository(request.worktreePath);
  if (source.repoKey !== target.repoKey) throw new Error("정리 대상이 같은 Git 저장소가 아닙니다.");
  const targetStatus = await git(request.worktreePath, ["status", "--porcelain=v1"]);
  if (targetStatus) throw new Error("워크트리에 미반영 변경이 있습니다.");
  await git(source.repoPath, ["worktree", "remove", "--", request.worktreePath]);
  // 작업 브랜치는 이력 보존을 위해 자동 삭제하지 않는다.
  return { removed: true, preservedBranch: true };
}

export interface PushRequest {
  readonly worktreePath: string;
  readonly remote: string;
  readonly remoteRef: string;
  readonly policy: PolicySnapshot;
  readonly approval?: ActionApproval;
}

export async function pushIntegratedHead(request: PushRequest): Promise<{ state: "pushed"; head: string }> {
  const decision = decideAction(request.policy, "push", request.approval);
  if (decision.kind !== "allowed") throw new Error(`push 승인 필요: ${decision.reason}`);
  if (!request.remote.trim() || !request.remoteRef.trim()) throw new Error("push remote/ref가 필요합니다.");
  const status = await git(request.worktreePath, ["status", "--porcelain=v1"]);
  if (status) throw new Error("미반영 변경이 있는 작업대는 push할 수 없습니다.");
  const head = await git(request.worktreePath, ["rev-parse", "HEAD"]);
  await git(request.worktreePath, ["push", request.remote, `HEAD:${request.remoteRef}`]);
  return { state: "pushed", head };
}

export interface PullRequestInput {
  readonly repoKey: string;
  readonly headRef: string;
  readonly baseRef: string;
  readonly title: string;
  readonly body: string;
}

export interface PullRequestProvider {
  create(input: PullRequestInput): Promise<{ url: string; id: string }>;
}

export async function createIntegratedPullRequest(
  input: PullRequestInput,
  policy: PolicySnapshot,
  approval: ActionApproval | undefined,
  provider: PullRequestProvider,
): Promise<{ state: "pr_created"; url: string; id: string }> {
  const decision = decideAction(policy, "createPR", approval);
  if (decision.kind !== "allowed") throw new Error(`PR 승인 필요: ${decision.reason}`);
  if (!input.headRef.trim() || !input.baseRef.trim() || !input.title.trim()) throw new Error("PR head/base/title이 필요합니다.");
  const result = await provider.create(input);
  if (!/^https:\/\//u.test(result.url)) throw new Error("PR 공급자가 유효한 HTTPS URL을 반환하지 않았습니다.");
  return { state: "pr_created", ...result };
}

export interface WorkflowInstructions {
  readonly preparationStepIds: readonly string[];
  readonly requiredChecks: readonly string[];
  readonly integrationActions: readonly ("merge" | "push" | "createPR")[];
}

export function normalizeWorkflowInstructions(value: WorkflowInstructions | undefined): WorkflowInstructions {
  if (!value) return { preparationStepIds: [], requiredChecks: [], integrationActions: [] };
  return {
    preparationStepIds: [...new Set(value.preparationStepIds)],
    requiredChecks: [...new Set(value.requiredChecks)],
    integrationActions: [...new Set(value.integrationActions)],
  };
}
