import { spawn } from "node:child_process";
import { createServer, type Server } from "node:net";

export interface EditorBuffer {
  readonly relativePath: string;
  readonly diskHash: string | null;
  readonly content: string;
  readonly dirty: boolean;
  readonly externalConflict: boolean;
  readonly cursorLine: number;
}

export interface TerminalSession {
  readonly id: string;
  readonly title: string;
  readonly state: "running" | "exited";
  readonly processId?: number;
}

export interface DebugSession {
  readonly id: string;
  readonly state: "running" | "paused" | "exited";
  readonly location?: string;
  readonly variables?: Readonly<Record<string, string>>;
  readonly sourceChanged: boolean;
}

export interface TaskIdeState {
  readonly taskId: string;
  readonly worktreePath: string;
  readonly languageServiceId: string;
  readonly buffers: Readonly<Record<string, EditorBuffer>>;
  readonly terminals: readonly TerminalSession[];
  readonly debuggers: readonly DebugSession[];
  readonly selectedBuffer?: string;
}

export class TaskIdeRegistry {
  readonly #tasks = new Map<string, TaskIdeState>();
  #activeTaskId: string | undefined;

  register(taskId: string, worktreePath: string): TaskIdeState {
    const existing = this.#tasks.get(taskId);
    if (existing) return existing;
    const value: TaskIdeState = {
      taskId,
      worktreePath,
      languageServiceId: `ls:${taskId}`,
      buffers: {},
      terminals: [],
      debuggers: [],
    };
    this.#tasks.set(taskId, value);
    return value;
  }

  select(taskId: string): TaskIdeState {
    const value = this.require(taskId);
    this.#activeTaskId = taskId;
    return value;
  }

  active(): TaskIdeState | undefined {
    return this.#activeTaskId ? this.#tasks.get(this.#activeTaskId) : undefined;
  }

  openBuffer(taskId: string, buffer: EditorBuffer): TaskIdeState {
    const current = this.require(taskId);
    return this.save({ ...current, buffers: { ...current.buffers, [buffer.relativePath]: { ...buffer } }, selectedBuffer: buffer.relativePath });
  }

  updateDraft(taskId: string, relativePath: string, content: string, cursorLine: number): TaskIdeState {
    const current = this.require(taskId);
    const buffer = current.buffers[relativePath];
    if (!buffer) throw new Error("열린 버퍼가 없습니다.");
    return this.save({
      ...current,
      buffers: { ...current.buffers, [relativePath]: { ...buffer, content, cursorLine, dirty: true } },
    });
  }

  markExternalChange(taskId: string, relativePath: string, newDiskHash: string | null): TaskIdeState {
    const current = this.require(taskId);
    const buffer = current.buffers[relativePath];
    if (!buffer) return current;
    const conflict = buffer.dirty && buffer.diskHash !== newDiskHash;
    return this.save({
      ...current,
      buffers: { ...current.buffers, [relativePath]: { ...buffer, externalConflict: conflict } },
    });
  }

  setTerminals(taskId: string, terminals: readonly TerminalSession[]): TaskIdeState {
    const current = this.require(taskId);
    return this.save({ ...current, terminals: terminals.map((item) => ({ ...item })) });
  }

  setDebuggers(taskId: string, debuggers: readonly DebugSession[]): TaskIdeState {
    const current = this.require(taskId);
    return this.save({ ...current, debuggers: debuggers.map((item) => ({ ...item, ...(item.variables ? { variables: { ...item.variables } } : {}) })) });
  }

  markSourceChanged(taskId: string, relativePath: string): TaskIdeState {
    const current = this.require(taskId);
    if (!current.buffers[relativePath]) return current;
    return this.save({ ...current, debuggers: current.debuggers.map((item) => item.state === "exited" ? item : { ...item, sourceChanged: true }) });
  }

  private require(taskId: string): TaskIdeState {
    const value = this.#tasks.get(taskId);
    if (!value) throw new Error("IDE 작업 컨텍스트가 없습니다.");
    return value;
  }

  private save(value: TaskIdeState): TaskIdeState {
    this.#tasks.set(value.taskId, value);
    return value;
  }
}

export interface PortLease {
  readonly taskId: string;
  readonly name: string;
  readonly port: number;
  readonly url: string;
}

interface HeldPort extends PortLease { readonly server: Server }

export class PortLeaseManager {
  readonly #leases = new Map<string, HeldPort>();

  async reserve(taskId: string, name: string, preferredPort?: number, host = "127.0.0.1"): Promise<PortLease> {
    const key = `${taskId}:${name}`;
    const existing = this.#leases.get(key);
    if (existing) return { taskId, name, port: existing.port, url: existing.url };

    const server = createServer();
    const port = await new Promise<number>((resolve, reject) => {
      server.once("error", reject);
      server.listen({ host, port: preferredPort ?? 0, exclusive: true }, () => {
        server.off("error", reject);
        const address = server.address();
        if (!address || typeof address === "string") return reject(new Error("포트 주소를 확인할 수 없습니다."));
        resolve(address.port);
      });
    });
    const lease: HeldPort = { taskId, name, port, url: `http://${host}:${port}`, server };
    this.#leases.set(key, lease);
    return { taskId, name, port, url: lease.url };
  }

  async release(taskId: string, name: string): Promise<void> {
    const key = `${taskId}:${name}`;
    const held = this.#leases.get(key);
    if (!held) return;
    this.#leases.delete(key);
    await new Promise<void>((resolve, reject) => held.server.close((error) => error ? reject(error) : resolve()));
  }

  async releaseTask(taskId: string): Promise<void> {
    const names = [...this.#leases.values()].filter((item) => item.taskId === taskId).map((item) => item.name);
    await Promise.all(names.map((name) => this.release(taskId, name)));
  }
}

export function openExternalUrl(url: string): void {
  const parsed = new URL(url);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("HTTP(S) URL만 외부 브라우저로 열 수 있습니다.");
  const command = process.platform === "win32" ? "cmd" : process.platform === "darwin" ? "open" : "xdg-open";
  const args = process.platform === "win32" ? ["/d", "/s", "/c", "start", "", parsed.toString()] : [parsed.toString()];
  const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true });
  child.unref();
}

export interface ExtensionManifest {
  readonly id: string;
  readonly version: string;
  readonly source: string;
}
export class GlobalExtensionRegistry {
  readonly #installed = new Map<string, ExtensionManifest>();

  install(manifest: ExtensionManifest, activeTaskCount = 0): void {
    if (!manifest.id.trim() || !manifest.version.trim() || !manifest.source.trim()) throw new Error("확장 ID·버전·출처가 필요합니다.");
    const previous = this.#installed.get(manifest.id);
    if (previous && previous.version !== manifest.version && activeTaskCount > 0) {
      throw new Error("실행 작업이 있는 동안 전역 확장 업데이트로 호스트를 재시작할 수 없습니다.");
    }
    this.#installed.set(manifest.id, { ...manifest });
  }

  list(): ExtensionManifest[] {
    return [...this.#installed.values()].map((item) => ({ ...item })).sort((a,b) => a.id.localeCompare(b.id));
  }

  forProject(_projectId: string): ExtensionManifest[] {
    // 첫 버전은 프로젝트별 비활성화를 제공하지 않고 앱 전체에 같은 확장 세트를 적용한다.
    return this.list();
  }
}
