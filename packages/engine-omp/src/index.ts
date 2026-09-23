import { Buffer } from "node:buffer";
import { createInterface } from "node:readline";
import { clearTimeout, setTimeout as sleepTimer, setTimeout } from "node:timers";
import { ProcessTreeSupervisor, type OwnedProcessHandle, type ProcessRole } from "@awi/processes";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Frame = { [key: string]: Json };

interface Pending {
  readonly resolve: (value: Frame) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
}

interface ChunkState {
  readonly count: number;
  readonly byteLength: number;
  readonly parts: Buffer[];
  nextIndex: number;
}

export interface OmpLaunchOptions {
  readonly taskId: string;
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly readyTimeoutMs?: number;
}

export interface AbortResult {
  readonly graceful: boolean;
  readonly fallbackUsed: boolean;
}

export interface DiscussionOverlay {
  readonly tools: readonly ["read", "glob", "grep", "todo"];
  readonly denied: readonly ["write", "edit", "bash", "eval", "task", "hub", "web_search"];
  readonly projectMcpEnabled: false;
}

export function discussionOverlay(): DiscussionOverlay {
  return {
    tools: ["read", "glob", "grep", "todo"],
    denied: ["write", "edit", "bash", "eval", "task", "hub", "web_search"],
    projectMcpEnabled: false,
  };
}

function isFrame(value: unknown): value is Frame {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => sleepTimer(resolve, ms));
}

export class OmpEngineAdapter {
  readonly #pending = new Map<string, Pending>();
  readonly #chunks = new Map<string, ChunkState>();
  readonly #events: Frame[] = [];
  #handle: OwnedProcessHandle | undefined;
  #nextId = 0;
  #ready: Frame | undefined;

  constructor(private readonly supervisor: ProcessTreeSupervisor) {}

  async start(options: OmpLaunchOptions): Promise<Frame> {
    if (this.#handle) throw new Error("OMP 세션이 이미 시작되었습니다.");
    const handle = this.supervisor.start({
      ownerId: options.taskId,
      role: "engine",
      executable: options.executable,
      args: options.args,
      cwd: options.cwd,
      ...(options.env ? { env: options.env } : {}),
    });
    this.#handle = handle;
    handle.child.stdout.setEncoding("utf8");
    handle.child.stderr.setEncoding("utf8");
    const lines = createInterface({ input: handle.child.stdout, crlfDelay: Number.POSITIVE_INFINITY });
    lines.on("line", (line) => this.#onLine(line));
    handle.child.once("exit", () => {
      for (const pending of this.#pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error("OMP 프로세스가 종료되었습니다."));
      }
      this.#pending.clear();
    });
    this.#ready = await this.waitForEvent((frame) => frame.type === "ready", options.readyTimeoutMs ?? 45_000);
    return this.#ready;
  }

  get ready(): Frame | undefined { return this.#ready; }
  get events(): readonly Frame[] { return [...this.#events]; }

  async send(command: Frame, timeoutMs = 60_000): Promise<Frame> {
    const handle = this.#handle;
    if (!handle) throw new Error("OMP 세션이 시작되지 않았습니다.");
    const id = typeof command.id === "string" ? command.id : `req-${++this.#nextId}`;
    const payload = JSON.stringify({ ...command, id });
    return new Promise<Frame>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`OMP 응답 대기 초과: ${id}`));
      }, timeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
      handle.child.stdin.write(payload + "\n");
    });
  }

  async prompt(message: string, attachments: readonly Json[] = []): Promise<Frame> {
    if (!message.trim() && attachments.length === 0) throw new Error("전달할 지시나 첨부가 필요합니다.");
    return this.send({ type: "prompt", message, attachments: [...attachments] });
  }

  async steer(message: string): Promise<Frame> {
    if (!message.trim()) throw new Error("즉시 지시가 비어 있습니다.");
    return this.send({ type: "steer", message });
  }

  async state(): Promise<Frame> {
    return this.send({ type: "get_state" });
  }

  async abortTask(taskId: string, gracefulWaitMs = 1_500): Promise<AbortResult> {
    await this.send({ type: "abort" }).catch(() => undefined);
    const deadline = Date.now() + gracefulWaitMs;
    while (Date.now() < deadline) {
      const response = await this.state().catch(() => undefined);
      const data = response?.data;
      if (isFrame(data) && data.isStreaming === false) return { graceful: true, fallbackUsed: false };
      await wait(100);
    }
    const shortLivedRoles = new Set<ProcessRole>(["engine", "shell", "build"]);
    await this.supervisor.stopOwner(taskId, { graceMs: 500, forceWaitMs: 5_000 }, shortLivedRoles);
    return { graceful: false, fallbackUsed: true };
  }

  async shutdown(taskId: string): Promise<void> {
    await this.supervisor.stopOwner(taskId, { graceMs: 500, forceWaitMs: 5_000 });
    this.#handle = undefined;
  }

  async waitForEvent(predicate: (frame: Frame) => boolean, timeoutMs = 60_000): Promise<Frame> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const frame = this.#events.find(predicate);
      if (frame) return frame;
      if (Date.now() >= deadline) throw new Error("OMP 이벤트 대기 시간이 초과되었습니다.");
      await wait(25);
    }
  }

  #onLine(line: string): void {
    const text = line.trim();
    if (!text) return;
    let parsed: unknown;
    try { parsed = JSON.parse(text); }
    catch { return; }
    if (!isFrame(parsed)) return;
    if (parsed.type === "rpc_chunk") {
      this.#onChunk(parsed);
      return;
    }
    this.#dispatch(parsed);
  }

  #dispatch(frame: Frame): void {
    if (frame.type === "response" && typeof frame.id === "string") {
      const pending = this.#pending.get(frame.id);
      if (pending) {
        this.#pending.delete(frame.id);
        clearTimeout(pending.timer);
        pending.resolve(frame);
        return;
      }
    }
    if (typeof frame.type === "string" && frame.type !== "response") this.#events.push(frame);
  }

  #onChunk(frame: Frame): void {
    if (typeof frame.chunkId !== "string" || typeof frame.index !== "number" ||
        typeof frame.count !== "number" || typeof frame.byteLength !== "number" ||
        typeof frame.data !== "string") return;
    const existing = this.#chunks.get(frame.chunkId);
    const entry = frame.index === 0 || !existing
      ? { count: frame.count, byteLength: frame.byteLength, parts: [], nextIndex: 0 }
      : existing;
    if (entry.count !== frame.count || entry.byteLength !== frame.byteLength || entry.nextIndex !== frame.index) {
      this.#chunks.delete(frame.chunkId);
      return;
    }
    const bytes = Buffer.from(frame.data, "base64");
    if (bytes.length > 256 * 1024) {
      this.#chunks.delete(frame.chunkId);
      return;
    }
    entry.parts[frame.index] = bytes;
    entry.nextIndex++;
    this.#chunks.set(frame.chunkId, entry);
    if (entry.nextIndex !== entry.count) return;
    this.#chunks.delete(frame.chunkId);
    const payload = Buffer.concat(entry.parts);
    if (payload.byteLength !== entry.byteLength) return;
    try {
      const decoded: unknown = JSON.parse(payload.toString("utf8"));
      if (isFrame(decoded)) this.#dispatch(decoded);
    } catch {
      // 손상된 청크는 세션 전체를 성공으로 오판하지 않고 버린다.
    }
  }
}
