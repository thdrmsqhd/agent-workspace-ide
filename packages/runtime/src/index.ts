import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { acquireSlot, releaseSlot } from "@awi/core";
import { OmpEngineAdapter, discussionOverlay } from "@awi/engine-omp";
import type { StateStore } from "@awi/persistence";
import { ProcessTreeSupervisor } from "@awi/processes";
import type { AgentSettings, SettingsRegistry, TaskSettingsSnapshot } from "@awi/settings";
import { inspectRepository, prepareWorktree } from "@awi/worktrees";

export interface EngineSessionFactory {
  create(taskId: string, cwd: string, settings: TaskSettingsSnapshot, phase: "discussion" | "execution", sessionFile?: string): Promise<OmpEngineAdapter>;
}

export interface OmpFactoryOptions {
  readonly executable: string;
  readonly sessionRoot: string;
  readonly configRoot: string;
  readonly baseArgs?: readonly string[];
}

export class OmpSessionFactory implements EngineSessionFactory {
  constructor(private readonly supervisor: ProcessTreeSupervisor, private readonly options: OmpFactoryOptions) {}

  async create(taskId: string, cwd: string, settings: TaskSettingsSnapshot, phase: "discussion" | "execution", sessionFile?: string): Promise<OmpEngineAdapter> {
    const sessionDir = join(this.options.sessionRoot, taskId);
    await mkdir(sessionDir, { recursive: true });
    const args = ["--mode=rpc", `--cwd=${cwd}`, `--session-dir=${sessionDir}`, "--no-title", `--model=${settings.model}`, ...(this.options.baseArgs ?? [])];

    if (phase === "discussion") {
      await mkdir(this.options.configRoot, { recursive: true });
      const overlay = discussionOverlay();
      const configPath = join(this.options.configRoot, `${taskId}-discussion.yml`);
      const body = [
        "mcp:", "  enableProjectConfig: false", "tools:", "  approvalMode: yolo", "  approval:",
        ...overlay.denied.map((tool) => `    ${tool}: deny`), ""
      ].join("\n");
      await writeFile(configPath, body, { encoding:"utf8" });
      args.push(`--config=${configPath}`, `--tools=${overlay.tools.join(",")}`);
    }

    const adapter = new OmpEngineAdapter(this.supervisor);
    await adapter.start({ taskId, executable:this.options.executable, args, cwd });
    if (sessionFile) await adapter.switchSession(sessionFile);
    return adapter;
  }
}

interface SessionRecord {
  adapter: OmpEngineAdapter;
  sessionFile: string;
  phase: "discussion" | "execution";
  cwd: string;
}

export interface RuntimeOptions {
  readonly store: StateStore;
  readonly settings: SettingsRegistry;
  readonly supervisor: ProcessTreeSupervisor;
  readonly engineFactory: EngineSessionFactory;
  readonly worktreeRoot: string;
  readonly journalDirectory: string;
}

export class WorkspaceRuntime {
  readonly #sessions = new Map<string, SessionRecord>();
  #activeSlots = new Set<string>();

  constructor(private readonly options: RuntimeOptions) {}

  async registerProject(name: string, repoPath: string, defaultBranch: string, defaults: AgentSettings): Promise<string> {
    const repo = await inspectRepository(repoPath);
    const existing = this.options.store.findProjectByRepoKey(repo.repoKey);
    if (existing) return existing.id;
    const id = this.options.store.createProject(name, repo.repoPath, repo.repoKey, defaultBranch);
    this.options.settings.setProjectDefault(id, defaults);
    this.options.store.saveSettingsSnapshot("project", id, defaults);
    return id;
  }

  async createDiscussion(projectId: string, prompt: string, override: Partial<AgentSettings> = {}): Promise<string> {
    const project = this.options.store.getProjectInfo(projectId);
    const taskId = this.options.store.createDiscussion(projectId, prompt);
    const settings = this.options.settings.captureTask(taskId, projectId, override);
    this.options.store.saveSettingsSnapshot("task", taskId, settings);
    const adapter = await this.options.engineFactory.create(taskId, project.repoPath, settings, "discussion");
    await adapter.prompt(prompt);
    const sessionFile = await adapter.sessionFile();
    this.#sessions.set(taskId, { adapter, sessionFile, phase:"discussion", cwd:project.repoPath });
    this.options.store.recordImmediateMessage(taskId, "user", prompt);
    return taskId;
  }

  async startTask(taskId: string, baseRef?: string): Promise<void> {
    const task = this.options.store.getTaskInfo(taskId);
    if (task.phase !== "discussion") throw new Error("논의 상태의 작업만 시작할 수 있습니다.");
    const project = this.options.store.getProjectInfo(task.projectId);
    const settings = this.options.settings.taskSnapshot(taskId);
    if (!settings) throw new Error("작업 설정 스냅샷이 없습니다.");
    const current = this.#sessions.get(taskId);
    if (!current) throw new Error("논의 세션이 없습니다.");

    this.#activeSlots = acquireSlot(this.#activeSlots, taskId);
    try {
      const journal = await prepareWorktree({
        repoPath: project.repoPath,
        taskId,
        worktreeRoot: this.options.worktreeRoot,
        journalDirectory: this.options.journalDirectory,
        baseRef: baseRef ?? project.defaultBranch,
      });
      await current.adapter.shutdown(taskId);
      const adapter = await this.options.engineFactory.create(taskId, journal.worktreePath, settings, "execution", current.sessionFile);
      const relocated = await adapter.sessionFile();
      this.options.store.recordPreparedExecution(taskId, task.revision, journal.worktreePath);
      this.options.store.setTaskRunState(taskId, "running", "enabled");
      this.#sessions.set(taskId, { adapter, sessionFile:relocated, phase:"execution", cwd:journal.worktreePath });
      await adapter.prompt("논의에서 확정한 요구사항을 바탕으로 현재 워크트리에서 작업을 시작하라.");
    } catch (error) {
      this.#activeSlots = releaseSlot(this.#activeSlots, taskId);
      throw error;
    }
  }

  async send(taskId: string, text: string, mode: "immediate" | "queued", attachmentIds: readonly string[] = []): Promise<string | undefined> {
    const task = this.options.store.getTaskQueue(taskId);
    if (mode === "queued") {
      const result = this.options.store.applyQueueCommand({
        apiVersion:1, requestId:randomUUID(), method:"task.send", taskId, expectedRevision:task.revision,
        payload:{ text, attachmentIds:[...attachmentIds], delivery:"queued" }
      });
      return result.messageId;
    }
    const session = this.requireSession(taskId);
    const state = await session.adapter.state();
    const data = state.data;
    const streaming = typeof data === "object" && data !== null && !Array.isArray(data) && data.isStreaming === true;
    if (streaming) await session.adapter.steer(text);
    else await session.adapter.prompt(text, attachmentIds.map((id) => ({ id })));
    this.options.store.recordImmediateMessage(taskId, "user", text, attachmentIds);
    return undefined;
  }

  async dispatchNextQueued(taskId: string): Promise<boolean> {
    const item = this.options.store.claimNextMessage(taskId);
    if (!item) return false;
    const session = this.requireSession(taskId);
    try {
      const response = await session.adapter.prompt(item.text, item.attachmentIds.map((id) => ({ id })));
      this.options.store.markDispatchAccepted(taskId, item.id);
      const data = response.data;
      const localOnly = typeof data === "object" && data !== null && !Array.isArray(data) && data.agentInvoked === false;
      if (!localOnly) await session.adapter.waitForEvent((event) => event.type === "agent_end", 10 * 60_000);
      this.options.store.markDispatchFinished(taskId, item.id);
      return true;
    } catch (error) {
      this.options.store.markDispatchUncertain(taskId, item.id);
      throw error;
    }
  }

  async abortTask(taskId: string): Promise<void> {
    this.options.store.applyQueueCommand({
      apiVersion:1, requestId:randomUUID(), method:"task.abort", taskId,
      payload:{ reason:"user" }
    });
    const session = this.requireSession(taskId);
    await session.adapter.abortTask(taskId);
    this.options.store.confirmAbort(taskId);
    this.#activeSlots = releaseSlot(this.#activeSlots, taskId);
  }

  async resumeTask(taskId: string, text?: string): Promise<void> {
    let session = this.#sessions.get(taskId);
    if (!session) throw new Error("재개할 세션 기록이 없습니다.");
    const settings = this.options.settings.taskSnapshot(taskId);
    if (!settings) throw new Error("작업 설정 스냅샷이 없습니다.");

    const alive = this.options.supervisor.list(taskId).some((item) => item.role === "engine" && item.state === "running");
    if (!alive) {
      const adapter = await this.options.engineFactory.create(taskId, session.cwd, settings, session.phase, session.sessionFile);
      session = { ...session, adapter };
      this.#sessions.set(taskId, session);
    }

    const queue = this.options.store.getTaskQueue(taskId);
    this.options.store.applyQueueCommand({
      apiVersion:1, requestId:randomUUID(), method:"task.resume", taskId, expectedRevision:queue.revision,
      payload:{}
    });
    this.#activeSlots = acquireSlot(this.#activeSlots, taskId);
    if (text?.trim()) await this.send(taskId, text, "immediate");
  }

  async shutdown(): Promise<void> {
    for (const [taskId, session] of this.#sessions) await session.adapter.shutdown(taskId);
    this.#sessions.clear();
    this.#activeSlots.clear();
  }

  private requireSession(taskId: string): SessionRecord {
    const session = this.#sessions.get(taskId);
    if (!session) throw new Error("실행 중인 OMP 세션이 없습니다.");
    return session;
  }
}
