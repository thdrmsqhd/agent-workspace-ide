import { randomUUID } from "node:crypto";
import { createCodeSelectionAttachment, createPathAttachment, type AttachmentItem } from "@awi/attachments";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { acquireSlot, releaseSlot } from "@awi/core";
import { OmpEngineAdapter, discussionOverlay } from "@awi/engine-omp";
import type { StateStore } from "@awi/persistence";
import { ProcessTreeSupervisor } from "@awi/processes";
import type { AgentSettings, SettingsRegistry, TaskSettingsSnapshot } from "@awi/settings";
import { inspectRepository, prepareWorktree } from "@awi/worktrees";
import { applySelectedChanges, previewChanges } from "@awi/worktrees/import";

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
  readonly #engineEventCursors = new Map<string, number>();
  #activeSlots = new Set<string>();

  constructor(private readonly options: RuntimeOptions) {}

  private settingsForTask(taskId: string): TaskSettingsSnapshot {
    const existing = this.options.settings.taskSnapshot(taskId);
    if (existing) return existing;
    const saved = this.options.store.getSettingsSnapshot("task", taskId);
    if (!saved) throw new Error("작업 설정 스냅샷이 없습니다.");
    const raw = saved.settings;
    if (typeof raw.projectId !== "string" || typeof raw.engine !== "string" || typeof raw.model !== "string" ||
        (raw.mode !== "manual" && raw.mode !== "automatic") || typeof raw.capturedAt !== "string" || typeof raw.sourceRevision !== "number") {
      throw new Error("저장된 작업 설정 스냅샷이 손상되었습니다.");
    }
    const snapshot: TaskSettingsSnapshot = {
      taskId,
      projectId: raw.projectId,
      engine: raw.engine,
      model: raw.model,
      mode: raw.mode,
      capturedAt: raw.capturedAt,
      sourceRevision: raw.sourceRevision,
    };
    this.options.settings.restoreTask(snapshot);
    return snapshot;
  }

  async registerProject(name: string, repoPath: string, defaultBranch: string, defaults: AgentSettings): Promise<string> {
    const repo = await inspectRepository(repoPath);
    const existing = this.options.store.findProjectByRepoKey(repo.repoKey);
    if (existing) {
      const saved = this.options.store.getSettingsSnapshot("project", existing.id);
      if (saved) {
        const raw = saved.settings;
        if (typeof raw.engine === "string" && typeof raw.model === "string" && (raw.mode === "manual" || raw.mode === "automatic")) {
          this.options.settings.restoreProject(existing.id, { engine: raw.engine, model: raw.model, mode: raw.mode }, saved.revision);
        }
      }
      return existing.id;
    }
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
    await adapter.setSubagentSubscription("progress");
    await adapter.prompt(prompt);
    const sessionFile = await adapter.sessionFile();
    this.#sessions.set(taskId, { adapter, sessionFile, phase:"discussion", cwd:project.repoPath });
    this.options.store.saveArtifact(taskId, "omp-session", sessionFile, { phase: "discussion", cwd: project.repoPath });
    this.options.store.recordImmediateMessage(taskId, "user", prompt);
    return taskId;
  }

  async startTask(taskId: string, baseRef?: string): Promise<void> {
    const task = this.options.store.getTaskInfo(taskId);
    if (task.phase !== "discussion") throw new Error("논의 상태의 작업만 시작할 수 있습니다.");
    const project = this.options.store.getProjectInfo(task.projectId);
    const settings = this.settingsForTask(taskId);
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
      await adapter.setSubagentSubscription("progress");
      const relocated = await adapter.sessionFile();
      this.options.store.recordPreparedExecution(taskId, task.revision, journal.worktreePath);
      this.options.store.setTaskRunState(taskId, "running", "enabled");
      this.#sessions.set(taskId, { adapter, sessionFile:relocated, phase:"execution", cwd:journal.worktreePath });
      this.options.store.saveArtifact(taskId, "omp-session", relocated, { phase: "execution", cwd: journal.worktreePath });
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



  updateProjectSettings(projectId: string, value: AgentSettings, expectedRevision: number): number {
    const revision = this.options.settings.setProjectDefault(projectId, value, expectedRevision);
    this.options.store.saveSettingsSnapshot("project", projectId, value, expectedRevision);
    return revision;
  }

  updateQueued(taskId: string, messageId: string, expectedMessageRevision: number, text: string, attachmentIds: readonly string[] = []): void {
    this.options.store.applyQueueCommand({
      apiVersion: 1,
      requestId: randomUUID(),
      method: "queue.update",
      taskId,
      expectedRevision: expectedMessageRevision,
      payload: { messageId, text, attachmentIds: [...attachmentIds] },
    });
  }

  deleteQueued(taskId: string, messageId: string, expectedMessageRevision: number): void {
    this.options.store.applyQueueCommand({
      apiVersion: 1,
      requestId: randomUUID(),
      method: "queue.delete",
      taskId,
      expectedRevision: expectedMessageRevision,
      payload: { messageId },
    });
  }

  async attachPath(taskId: string, kind: "file" | "folder" | "image", relativePath: string): Promise<AttachmentItem> {
    const task = this.options.store.getTaskInfo(taskId);
    const project = this.options.store.getProjectInfo(task.projectId);
    const root = task.worktreePath ?? project.repoPath;
    const attachment = await createPathAttachment(root, relativePath, kind);
    this.options.store.saveAttachment(taskId, {
      id: attachment.id,
      kind: attachment.kind,
      relativePath: attachment.relativePath,
      metadata: { size: attachment.size, sha256: attachment.sha256 ?? null, children: attachment.children ?? [] },
    });
    return attachment;
  }

  removeAttachment(taskId:string,attachmentId:string):void{
    this.options.store.deleteAttachment(taskId,attachmentId);
  }

  attachCodeSelection(taskId: string, relativePath: string, startLine: number, endLine: number, content: string): AttachmentItem {
    const attachment = createCodeSelectionAttachment(relativePath, startLine, endLine, content);
    this.options.store.saveAttachment(taskId, {
      id: attachment.id,
      kind: attachment.kind,
      relativePath: attachment.relativePath,
      metadata: { size: attachment.size, code: attachment.code ?? null },
    });
    return attachment;
  }

  async importExistingSession(input: {
    projectId: string;
    originalPrompt: string;
    sessionPath: string;
    baseRef?: string;
    sourcePath?: string;
    selectedChangeIds?: readonly string[];
    settingsOverride?: Partial<AgentSettings>;
  }): Promise<string> {
    const project = this.options.store.getProjectInfo(input.projectId);
    const taskId = this.options.store.createDiscussion(input.projectId, input.originalPrompt);
    const settings = this.options.settings.captureTask(taskId, input.projectId, input.settingsOverride ?? {});
    this.options.store.saveSettingsSnapshot("task", taskId, settings);
    this.#activeSlots = acquireSlot(this.#activeSlots, taskId);
    try {
      const journal = await prepareWorktree({
        repoPath: project.repoPath,
        taskId,
        worktreeRoot: this.options.worktreeRoot,
        journalDirectory: this.options.journalDirectory,
        baseRef: input.baseRef ?? project.defaultBranch,
      });
      if (input.sourcePath && input.selectedChangeIds?.length) {
        const preview = await previewChanges(input.sourcePath);
        await applySelectedChanges(preview, [...input.selectedChangeIds], journal.worktreePath);
      }
      const adapter = await this.options.engineFactory.create(taskId, journal.worktreePath, settings, "execution", input.sessionPath);
      await adapter.setSubagentSubscription("progress");
      const relocated = await adapter.sessionFile();
      this.options.store.recordPreparedExecution(taskId, 0, journal.worktreePath);
      this.options.store.setTaskRunState(taskId, "running", "enabled");
      this.#sessions.set(taskId, { adapter, sessionFile: relocated, phase: "execution", cwd: journal.worktreePath });
      this.options.store.saveArtifact(taskId, "omp-session", relocated, { phase: "execution", cwd: journal.worktreePath });
      this.options.store.recordImmediateMessage(taskId, "system", "기존 OMP 세션을 새 워크트리로 이전했습니다.");
      return taskId;
    } catch (error) {
      this.#activeSlots = releaseSlot(this.#activeSlots, taskId);
      throw error;
    }
  }

  async syncEngineEvents(taskId: string): Promise<{ inputRequestIds: string[]; subagentEvents: number }> {
    const session = this.requireSession(taskId);
    const cursor = this.#engineEventCursors.get(taskId) ?? 0;
    const events = session.adapter.events.slice(cursor);
    this.#engineEventCursors.set(taskId, session.adapter.events.length);
    const inputRequestIds: string[] = [];
    let subagentEvents = 0;
    for (const event of events) {
      if (event.type === "extension_ui_request" && typeof event.id === "string") {
        const method = typeof event.method === "string" ? event.method : "";
        if (["select", "confirm", "input", "editor", "cancel"].includes(method)) {
          const timeout = typeof event.timeout === "number" && event.timeout > 0 ? event.timeout : undefined;
          const expiresAt = timeout ? new Date(Date.now() + timeout).toISOString() : undefined;
          const inputRequestId = this.options.store.createInputRequest(taskId, {
            engineRequestId: event.id,
            method,
            title: typeof event.title === "string" ? event.title : "",
            message: typeof event.message === "string" ? event.message : "",
            options: Array.isArray(event.options) ? event.options : [],
          }, expiresAt);
          inputRequestIds.push(inputRequestId);
        }
      } else if (typeof event.type === "string" && event.type.startsWith("subagent_")) {
        subagentEvents++;
      }
    }
    return { inputRequestIds, subagentEvents };
  }

  async respondInput(inputRequestId: string, response: { value: string } | { confirmed: boolean } | { cancelled: true; timedOut?: boolean }): Promise<void> {
    const request = this.options.store.getInputRequest(inputRequestId);
    if (!request) throw new Error("입력 요청이 없습니다.");
    if (request.status !== "pending") throw new Error("E_INPUT_CLOSED: 이미 처리된 입력 요청입니다.");
    if (request.expiresAt && Date.parse(request.expiresAt) <= Date.now()) {
      this.options.store.respondInputRequest(inputRequestId, response as Record<string, unknown>);
      return;
    }
    const engineRequestId = request.payload.engineRequestId;
    if (typeof engineRequestId !== "string") throw new Error("엔진 입력 요청 ID가 없습니다.");
    const session = this.requireSession(request.taskId);
    session.adapter.respondExtensionUi(engineRequestId, response);
    this.options.store.respondInputRequest(inputRequestId, response as Record<string, unknown>);
  }

  async subagents(taskId: string): Promise<unknown> {
    const response = await this.requireSession(taskId).adapter.getSubagents();
    return response.data;
  }

  async subagentMessages(taskId: string, options: { subagentId?: string; sessionFile?: string; fromByte?: number } = {}): Promise<unknown> {
    const response = await this.requireSession(taskId).adapter.getSubagentMessages(options);
    return response.data;
  }

  async changeModel(taskId: string, provider: string, modelId: string): Promise<void> {
    await this.requireSession(taskId).adapter.setModel(provider, modelId);
  }

  async historyPage(taskId: string, cursor?: string, limit?: number): Promise<unknown> {
    const response = await this.requireSession(taskId).adapter.getMessagesPage(cursor, limit);
    return response.data;
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
    const settings = this.settingsForTask(taskId);
    if (!session) {
      const artifact = this.options.store.latestArtifact(taskId, "omp-session");
      if (!artifact || typeof artifact.metadata.cwd !== "string" ||
          (artifact.metadata.phase !== "discussion" && artifact.metadata.phase !== "execution")) {
        throw new Error("재개할 OMP 세션 기록이 없습니다.");
      }
      session = {
        adapter: await this.options.engineFactory.create(taskId, artifact.metadata.cwd, settings, artifact.metadata.phase, artifact.location),
        sessionFile: artifact.location,
        phase: artifact.metadata.phase,
        cwd: artifact.metadata.cwd,
      };
      await session.adapter.setSubagentSubscription("progress");
      this.#sessions.set(taskId, session);
    }

    const alive = this.options.supervisor.list(taskId).some((item) => item.role === "engine" && item.state === "running");
    if (!alive) {
      const adapter = await this.options.engineFactory.create(taskId, session.cwd, settings, session.phase, session.sessionFile);
      await adapter.setSubagentSubscription("progress");
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


  async cancelTask(taskId: string): Promise<void> {
    const task = this.options.store.getTaskInfo(taskId);
    if (["running","waiting_input","reconnecting","stopping"].includes(task.runState) && this.#sessions.has(taskId)) {
      await this.abortTask(taskId);
    }
    this.options.store.setTaskDisposition(taskId, "cancelled");
  }

  async completeTask(taskId: string): Promise<void> {
    const task = this.options.store.getTaskInfo(taskId);
    if (["running","waiting_input","reconnecting","stopping"].includes(task.runState)) {
      throw new Error("실행 중인 작업은 완료 처리할 수 없습니다.");
    }
    this.options.store.setTaskDisposition(taskId, "completed");
  }

  archiveTask(taskId: string): void {
    this.options.store.archiveTask(taskId);
  }


  async reconnectTask(taskId: string): Promise<void> {
    const current=this.#sessions.get(taskId);
    if(current) await current.adapter.shutdown(taskId);
    this.#sessions.delete(taskId);
    this.options.store.setTaskRunState(taskId,"reconnecting","paused");
    const settings=this.settingsForTask(taskId);
    const artifact=this.options.store.latestArtifact(taskId,"omp-session");
    if(!artifact || typeof artifact.metadata.cwd!=="string" ||
       (artifact.metadata.phase!=="discussion" && artifact.metadata.phase!=="execution")) {
      this.options.store.setTaskRunState(taskId,"failed","paused");
      throw new Error("재연결할 OMP 세션 기록이 없습니다.");
    }
    const adapter=await this.options.engineFactory.create(taskId,artifact.metadata.cwd,settings,artifact.metadata.phase,artifact.location);
    await adapter.setSubagentSubscription("progress");
    const state=await adapter.state();
    const sessionFile=await adapter.sessionFile();
    this.#sessions.set(taskId,{adapter,sessionFile,phase:artifact.metadata.phase,cwd:artifact.metadata.cwd});
    this.options.store.saveArtifact(taskId,"omp-session",sessionFile,{phase:artifact.metadata.phase,cwd:artifact.metadata.cwd,reconnected:true});
    const data=state.data;
    const streaming=typeof data==="object"&&data!==null&&!Array.isArray(data)&&data.isStreaming===true;
    this.options.store.setTaskRunState(taskId,streaming?"paused":"paused","paused");
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
