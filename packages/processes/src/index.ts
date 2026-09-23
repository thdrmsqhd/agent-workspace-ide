import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";

export type ProcessRole = "engine" | "shell" | "server" | "build" | "debugger" | "other";

export interface OwnedProcessSpec {
  readonly ownerId: string;
  readonly role: ProcessRole;
  readonly executable: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
}

export interface OwnedProcessHandle {
  readonly id: string;
  readonly ownerId: string;
  readonly role: ProcessRole;
  readonly pid: number;
  readonly child: ChildProcessWithoutNullStreams;
}

export interface ProcessSnapshot {
  readonly id: string;
  readonly ownerId: string;
  readonly role: ProcessRole;
  readonly pid: number;
  readonly startedAt: string;
  readonly state: "running" | "exited";
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
}

export interface StopOptions {
  /** POSIX에서 SIGTERM 뒤 SIGKILL로 승격하기 전 대기 시간. Windows는 taskkill /T /F를 사용한다. */
  readonly graceMs?: number;
  readonly forceWaitMs?: number;
}

export interface StopResult {
  readonly id: string;
  readonly ownerId: string;
  readonly pid: number;
  readonly method: "already-exited" | "posix-group" | "windows-taskkill-tree";
  readonly forced: boolean;
}

interface TrackedProcess extends OwnedProcessHandle {
  readonly startedAt: string;
}

const DEFAULT_GRACE_MS = 1_500;
const DEFAULT_FORCE_WAIT_MS = 5_000;

function isRunning(child: ChildProcessWithoutNullStreams): boolean {
  return child.exitCode === null && child.signalCode === null;
}

function waitForExit(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<boolean> {
  if (!isRunning(child)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => finish(false), timeoutMs);
    const onExit = (): void => finish(true);
    const finish = (value: boolean): void => {
      clearTimeout(timer);
      child.off("exit", onExit);
      resolve(value);
    };
    child.once("exit", onExit);
  });
}

function signalPosixTree(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): void {
  const pid = child.pid;
  if (pid === undefined) return;
  try {
    // start()가 detached process group을 만들기 때문에 음수 PID로 해당 작업 트리만 신호한다.
    process.kill(-pid, signal);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") {
      if (isRunning(child)) child.kill(signal);
      return;
    }
    throw error;
  }
}

async function taskkillTree(pid: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    // shell 문자열을 사용하지 않는다. /T는 자손, /F는 콘솔/GUI 자손까지 확실히 종료한다.
    const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    });
    killer.once("error", reject);
    killer.once("exit", () => resolve());
  });
}

/**
 * OS 프로세스를 작업(ownerId)에 귀속시켜 다른 작업과 분리한다.
 * Windows에서는 taskkill /T, POSIX에서는 detached process group으로 전체 자손을 종료한다.
 */
export class ProcessTreeSupervisor {
  readonly #processes = new Map<string, TrackedProcess>();

  start(spec: OwnedProcessSpec): OwnedProcessHandle {
    if (!spec.ownerId.trim()) throw new Error("ownerId가 필요합니다.");
    if (!spec.executable.trim()) throw new Error("실행 파일 경로가 필요합니다.");

    const child = spawn(spec.executable, [...(spec.args ?? [])], {
      ...(spec.cwd === undefined ? {} : { cwd: spec.cwd }),
      env: spec.env === undefined ? process.env : { ...process.env, ...spec.env },
      detached: process.platform !== "win32",
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    // 호출자가 error 이벤트를 별도로 구독하지 않아도 ENOENT가 프로세스를 죽이지 않게 한다.
    child.on("error", () => undefined);
    if (child.pid === undefined) {
      child.kill();
      throw new Error(`프로세스를 시작하지 못했습니다: ${spec.executable}`);
    }

    const tracked: TrackedProcess = {
      id: randomUUID(),
      ownerId: spec.ownerId,
      role: spec.role,
      pid: child.pid,
      child,
      startedAt: new Date().toISOString(),
    };
    this.#processes.set(tracked.id, tracked);
    return {
      id: tracked.id,
      ownerId: tracked.ownerId,
      role: tracked.role,
      pid: tracked.pid,
      child: tracked.child,
    };
  }

  list(ownerId?: string): ProcessSnapshot[] {
    return [...this.#processes.values()]
      .filter((item) => ownerId === undefined || item.ownerId === ownerId)
      .map((item) => ({
        id: item.id,
        ownerId: item.ownerId,
        role: item.role,
        pid: item.pid,
        startedAt: item.startedAt,
        state: isRunning(item.child) ? "running" : "exited",
        exitCode: item.child.exitCode,
        signalCode: item.child.signalCode,
      }));
  }

  async stop(id: string, options: StopOptions = {}): Promise<StopResult> {
    const tracked = this.#processes.get(id);
    if (tracked === undefined) throw new Error(`소유 프로세스를 찾을 수 없습니다: ${id}`);
    if (!isRunning(tracked.child)) {
      return { id, ownerId: tracked.ownerId, pid: tracked.pid, method: "already-exited", forced: false };
    }

    const graceMs = options.graceMs ?? DEFAULT_GRACE_MS;
    const forceWaitMs = options.forceWaitMs ?? DEFAULT_FORCE_WAIT_MS;
    if (graceMs < 0 || forceWaitMs <= 0) throw new Error("종료 대기 시간은 유효한 양수여야 합니다.");

    if (process.platform === "win32") {
      await taskkillTree(tracked.pid);
      if (!(await waitForExit(tracked.child, forceWaitMs))) {
        throw new Error(`Windows 프로세스 트리가 종료되지 않았습니다: PID ${tracked.pid}`);
      }
      return { id, ownerId: tracked.ownerId, pid: tracked.pid, method: "windows-taskkill-tree", forced: true };
    }

    signalPosixTree(tracked.child, "SIGTERM");
    if (await waitForExit(tracked.child, graceMs)) {
      return { id, ownerId: tracked.ownerId, pid: tracked.pid, method: "posix-group", forced: false };
    }

    signalPosixTree(tracked.child, "SIGKILL");
    if (!(await waitForExit(tracked.child, forceWaitMs))) {
      throw new Error(`POSIX 프로세스 그룹이 종료되지 않았습니다: PGID ${tracked.pid}`);
    }
    return { id, ownerId: tracked.ownerId, pid: tracked.pid, method: "posix-group", forced: true };
  }

  async stopOwner(ownerId: string, options: StopOptions = {}, roles?: ReadonlySet<ProcessRole>): Promise<StopResult[]> {
    const targets = [...this.#processes.values()].filter((item) =>
      item.ownerId === ownerId && isRunning(item.child) && (roles === undefined || roles.has(item.role)));
    return Promise.all(targets.map((item) => this.stop(item.id, options)));
  }

  async stopAll(options: StopOptions = {}): Promise<StopResult[]> {
    const targets = [...this.#processes.values()].filter((item) => isRunning(item.child));
    return Promise.all(targets.map((item) => this.stop(item.id, options)));
  }
}
