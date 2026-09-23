export type ExecutionMode = "manual" | "automatic";
export interface AgentSettings {
  readonly engine: string;
  readonly model: string;
  readonly mode: ExecutionMode;
}

export interface TaskSettingsSnapshot extends AgentSettings {
  readonly taskId: string;
  readonly projectId: string;
  readonly capturedAt: string;
  readonly sourceRevision: number;
}

interface ProjectSettingsRecord {
  readonly settings: AgentSettings;
  readonly revision: number;
}

export class SettingsRegistry {
  readonly #projects = new Map<string, ProjectSettingsRecord>();
  readonly #tasks = new Map<string, TaskSettingsSnapshot>();

  setProjectDefault(projectId: string, settings: AgentSettings, expectedRevision?: number): number {
    if (!projectId.trim() || !settings.engine.trim() || !settings.model.trim()) throw new Error("프로젝트·엔진·모델 설정이 필요합니다.");
    const current = this.#projects.get(projectId);
    const revision = current?.revision ?? 0;
    if (expectedRevision !== undefined && revision !== expectedRevision) throw new Error("E_REVISION_CONFLICT: 프로젝트 설정이 변경되었습니다.");
    const next = current ? revision + 1 : 0;
    this.#projects.set(projectId, { settings: { ...settings }, revision: next });
    return next;
  }

  projectDefault(projectId: string): { settings: AgentSettings; revision: number } | undefined {
    const value = this.#projects.get(projectId);
    return value ? { settings: { ...value.settings }, revision: value.revision } : undefined;
  }

  captureTask(taskId: string, projectId: string, override: Partial<AgentSettings> = {}): TaskSettingsSnapshot {
    if (this.#tasks.has(taskId)) throw new Error("작업 설정 스냅샷은 실행 중 조용히 변경할 수 없습니다.");
    const project = this.#projects.get(projectId);
    if (!project) throw new Error("프로젝트 기본 설정이 없습니다.");
    const settings = { ...project.settings, ...override };
    if (!settings.engine.trim() || !settings.model.trim()) throw new Error("작업 엔진·모델이 필요합니다.");
    const snapshot: TaskSettingsSnapshot = {
      taskId,
      projectId,
      ...settings,
      capturedAt: new Date().toISOString(),
      sourceRevision: project.revision,
    };
    this.#tasks.set(taskId, snapshot);
    return { ...snapshot };
  }

  taskSnapshot(taskId: string): TaskSettingsSnapshot | undefined {
    const value = this.#tasks.get(taskId);
    return value ? { ...value } : undefined;
  }

  restoreProject(projectId: string, settings: AgentSettings, revision: number): void {
    if (revision < 0 || !Number.isInteger(revision)) throw new Error("프로젝트 설정 revision이 올바르지 않습니다.");
    this.#projects.set(projectId, { settings: { ...settings }, revision });
  }

  restoreTask(snapshot: TaskSettingsSnapshot): void {
    this.#tasks.set(snapshot.taskId, { ...snapshot });
  }
}
