export type ExecutionMode = "discussion" | "manual" | "automatic";
export type Action = "read" | "search" | "edit" | "runLocal" | "merge" | "push" | "createPR" | "unknownTool";

export interface PolicySnapshot {
  readonly mode: ExecutionMode;
  readonly policyHash: string;
  /** 프로젝트 지침과 사용자 지시에서 구조화하고 검토한 행위만 넣는다. */
  readonly allowedActions: ReadonlySet<Action>;
  readonly targetHead?: string;
  readonly snapshotId?: string;
}

export interface ActionApproval {
  readonly snapshotId: string;
  readonly targetHead: string;
  readonly policyHash: string;
  readonly actions: ReadonlySet<Action>;
}

export type Decision = { kind: "allowed" } | { kind: "denied"; reason: string } | { kind: "needs_approval"; reason: string };

/** 엔진 훅·프로세스 경계에서 호출할 정책 판정. UI 표시만으로 보안 강제를 주장하지 않는다. */
export function decideAction(policy: PolicySnapshot, action: Action, approval?: ActionApproval): Decision {
  if (action === "read" || action === "search") return { kind: "allowed" };
  if (action === "unknownTool") return { kind: "denied", reason: "허용 범위가 확인되지 않은 도구입니다." };
  if (policy.mode === "discussion") return { kind: "denied", reason: "논의 단계에서는 변경·셸·외부 반영을 실행할 수 없습니다." };
  if (!policy.allowedActions.has(action)) {
    return { kind: "needs_approval", reason: "프로젝트 지침이나 사용자 지시에서 허용 여부가 확인되지 않았습니다." };
  }
  if (action === "edit" || action === "runLocal") return { kind: "allowed" };
  if (policy.mode === "automatic") return { kind: "allowed" };
  if (!policy.snapshotId || !policy.targetHead || !approval ||
      approval.snapshotId !== policy.snapshotId || approval.targetHead !== policy.targetHead ||
      approval.policyHash !== policy.policyHash || !approval.actions.has(action)) {
    return { kind: "needs_approval", reason: "현재 검토 스냅샷·대상 HEAD·정책에 대한 승인이 필요합니다." };
  }
  return { kind: "allowed" };
}
