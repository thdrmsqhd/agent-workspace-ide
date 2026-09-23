export interface ProjectItem { readonly id: string; readonly name: string; readonly createdAt: string }
export interface QueueUiItem {
  readonly id: string;
  readonly text: string;
  readonly revision: number;
  readonly state: "queued" | "dispatching" | "accepted" | "finished" | "failed" | "unknown" | "deleted";
}
export interface InputRequestUiItem {
  readonly id: string;
  readonly title?: string;
  readonly message: string;
  readonly options?: readonly string[];
}
export interface TaskItem {
  readonly id: string;
  readonly projectId: string;
  readonly originalPrompt: string;
  readonly createdAt: string;
  readonly status: string;
  readonly currentAction?: string;
  readonly changedFileCount: number;
  readonly pendingInputCount: number;
  readonly archived: boolean;
  readonly queue?: readonly QueueUiItem[];
  readonly inputRequests?: readonly InputRequestUiItem[];
}
export interface AgentItem {
  readonly id: string;
  readonly taskId: string;
  readonly parentAgentId?: string;
  readonly status: string;
  readonly currentAction?: string;
}
export interface ViewState {
  /** 전체 현황은 고정이며 닫지 않는다. */
  readonly activeTab: "overview" | string;
  readonly taskTabs: readonly string[];
  readonly selectedNewProjectId?: string;
  readonly lastViewedTaskId?: string;
  readonly leftCollapsed: boolean;
  readonly rightCollapsed: boolean;
  readonly expandedProjectIds: ReadonlySet<string>;
  readonly expandedAgentIds: ReadonlySet<string>;
  readonly drafts: Readonly<Record<string, string>>;
  readonly newRequestDrafts: Readonly<Record<string, string>>;
}
export interface WorkspaceData {
  readonly projects: readonly ProjectItem[];
  readonly tasks: readonly TaskItem[];
  readonly agents: readonly AgentItem[];
}
export type ViewAction =
  | { kind: "selectNewProject"; projectId: string }
  | { kind: "openTask"; taskId: string }
  | { kind: "closeTaskTab"; taskId: string }
  | { kind: "openOverview" }
  | { kind: "toggleLeft" }
  | { kind: "toggleRight" }
  | { kind: "toggleProject"; projectId: string }
  | { kind: "toggleAgent"; agentId: string }
  | { kind: "setDraft"; taskId: string; text: string }
  | { kind: "setNewDraft"; projectId: string; text: string };

export function createInitialView(projectIds: readonly string[] = []): ViewState {
  return { activeTab: "overview", taskTabs: [], leftCollapsed: true, rightCollapsed: false,
    expandedProjectIds: new Set(projectIds), expandedAgentIds: new Set(), drafts: {}, newRequestDrafts: {} };
}

function toggle(values: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(values);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

/** 작업 탭은 뷰 상태만 바꾼다. 이 함수에 엔진/프로세스 종료 동작은 없다. */
export function reduceView(view: ViewState, action: ViewAction, data: WorkspaceData): ViewState {
  switch (action.kind) {
    case "selectNewProject":
      if (!data.projects.some((item) => item.id === action.projectId)) throw new Error("프로젝트가 없습니다.");
      return { ...view, selectedNewProjectId: action.projectId };
    case "openTask":
      if (!data.tasks.some((item) => item.id === action.taskId)) throw new Error("작업이 없습니다.");
      return { ...view, activeTab: action.taskId, lastViewedTaskId: action.taskId,
        leftCollapsed: false, taskTabs: view.taskTabs.includes(action.taskId) ? view.taskTabs : [...view.taskTabs, action.taskId] };
    case "closeTaskTab":
      if (!view.taskTabs.includes(action.taskId)) return view;
      return { ...view, taskTabs: view.taskTabs.filter((id) => id !== action.taskId),
        activeTab: view.activeTab === action.taskId ? "overview" : view.activeTab,
        leftCollapsed: view.activeTab === action.taskId ? true : view.leftCollapsed };
    case "openOverview":
      return { ...view, activeTab: "overview", leftCollapsed: true };
    case "toggleLeft": return { ...view, leftCollapsed: !view.leftCollapsed };
    case "toggleRight": return { ...view, rightCollapsed: !view.rightCollapsed };
    case "toggleProject":
      return { ...view, expandedProjectIds: toggle(view.expandedProjectIds, action.projectId) };
    case "toggleAgent":
      return { ...view, expandedAgentIds: toggle(view.expandedAgentIds, action.agentId) };
    case "setDraft":
      return { ...view, drafts: { ...view.drafts, [action.taskId]: action.text } };
    case "setNewDraft":
      return { ...view, newRequestDrafts: { ...view.newRequestDrafts, [action.projectId]: action.text } };
  }
}

/** 상단 입력 대상은 선택 프로젝트, 왼쪽 파일 대상은 열린 작업 탭에만 따른다. */
export function projectForNewRequest(view: ViewState): string | undefined {
  return view.selectedNewProjectId;
}

export function fileContextTask(view: ViewState): string | undefined {
  return view.activeTab === "overview" ? view.lastViewedTaskId : view.activeTab;
}

export interface AgentTreeNode extends AgentItem { children: AgentTreeNode[] }

/** 불명 부모·순환 관계를 추측해 붙이지 않고 별도 재조회 대상으로 반환한다. */
export function agentTree(agents: readonly AgentItem[], taskId: string): { roots: AgentTreeNode[]; unresolved: AgentTreeNode[] } {
  const nodes = new Map(agents.filter((item) => item.taskId === taskId).map((item) => [item.id, { ...item, children: [] as AgentTreeNode[] }]));
  const roots: AgentTreeNode[] = [];
  const unresolved: AgentTreeNode[] = [];
  for (const agent of agents) {
    const node = nodes.get(agent.id);
    if (!node) continue;
    if (!agent.parentAgentId) { roots.push(node); continue; }
    const parent = nodes.get(agent.parentAgentId);
    const visited = new Set([agent.id]);
    let cursor = parent;
    while (cursor?.parentAgentId && !visited.has(cursor.id)) {
      visited.add(cursor.id);
      cursor = nodes.get(cursor.parentAgentId);
    }
    if (!parent || !cursor || visited.has(cursor.id)) unresolved.push(node);
    else parent.children.push(node);
  }
  return { roots, unresolved };
}

/** 카드 순서=생성 순, 완료·취소는 별도 접힘 그룹. */
export function projectCards(data: WorkspaceData, projectId: string): { active: TaskItem[]; archived: TaskItem[] } {
  const tasks = data.tasks.filter((item) => item.projectId === projectId);
  return {
    active: tasks.filter((item) => !item.archived),
    archived: tasks.filter((item) => item.archived),
  };
}
