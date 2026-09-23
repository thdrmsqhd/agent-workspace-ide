// OMP RPC(stdio JSON Lines) 검증용 최소 클라이언트.
// 계약 출처: 설치된 @oh-my-pi/pi-coding-agent 18.2.5 src/modes/rpc/rpc-types.ts
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createInterface } from "node:readline";
import { Buffer } from "node:buffer";
import { clearTimeout, setTimeout } from "node:timers";
import process from "node:process";

const isRecord = (value) => typeof value === "object" && value !== null;

export class OmpRpcClient {
  #child = null;
  #nextId = 0;
  #pending = new Map();
  #chunks = new Map();

  constructor({ bin, args, cwd, env, rawLogPath, readyTimeoutMs = 45000 }) {
    this.bin = bin;
    this.args = args;
    this.cwd = cwd;
    this.env = env;
    this.rawLogPath = rawLogPath;
    this.readyTimeoutMs = readyTimeoutMs;
    this.frames = [];
    this.events = [];
    this.unparsedLines = [];
    this.stderrText = "";
    this.exit = null;
    this.ready = null;
    // 실행마다 원시 로그를 새로 쓴다. 이전 실행 기록과 섞이지 않게 한다.
    mkdirSync(dirname(rawLogPath), { recursive: true });
    writeFileSync(rawLogPath, "");
  }

  #record(direction, text) {
    appendFileSync(this.rawLogPath, `${JSON.stringify({ ts: Date.now(), direction, text })}\n`);
  }

  async start() {
    this.#child = spawn(this.bin, this.args, { cwd: this.cwd, env: this.env, windowsHide: true });
    this.#child.stdout.setEncoding("utf8");
    this.#child.stderr.setEncoding("utf8");
    const stdout = createInterface({ input: this.#child.stdout, crlfDelay: Number.POSITIVE_INFINITY });
    stdout.on("line", (line) => this.#onLine(line));
    this.#child.stderr.on("data", (text) => {
      this.stderrText += text;
    });
    this.#child.on("exit", (code, signal) => {
      this.exit = { code, signal, at: Date.now() };
    });
    this.ready = await this.waitForFrame((frame) => frame.type === "ready", {
      timeoutMs: this.readyTimeoutMs,
      description: "ready 프레임",
    });
    return this.ready;
  }

  #onLine(line) {
    const text = line.trim();
    if (text.length === 0) return;
    this.#record("stdout", text);
    let frame;
    try {
      frame = JSON.parse(text);
    } catch {
      this.unparsedLines.push(text);
      return;
    }
    if (isRecord(frame) && frame.type === "rpc_chunk") {
      this.#reassemble(frame);
      return;
    }
    this.frames.push(frame);
    if (isRecord(frame) && typeof frame.id === "string" && frame.type === "response") {
      const pending = this.#pending.get(frame.id);
      if (pending) {
        this.#pending.delete(frame.id);
        clearTimeout(pending.timer);
        pending.resolve(frame);
        return;
      }
    }
    if (isRecord(frame) && typeof frame.type === "string" && frame.type !== "response") this.events.push(frame);
  }

  #reassemble(frame) {
    // 계약(18.2.5 rpc-frame.ts): data는 256KiB 이하 청크 바이트의 독립 base64이고,
    // byteLength는 재조립된 논리 프레임 전체의 UTF-8 바이트 수다. 순서는 index 0부터 연속이어야 한다.
    const payloadLimit = 256 * 1024;
    const existing = this.#chunks.get(frame.chunkId);
    const entry =
      frame.index === 0 || existing === undefined || existing.complete
        ? { chunkId: frame.chunkId, count: frame.count, byteLength: frame.byteLength, parts: [], receivedBytes: 0, nextIndex: 0, invalid: null }
        : existing;
    if (entry.count !== frame.count) entry.invalid = "count 불일치";
    if (entry.byteLength !== frame.byteLength) entry.invalid = "byteLength 불일치";
    if (entry.nextIndex !== frame.index) entry.invalid = `순서 위반 (기대 ${entry.nextIndex}, 실제 ${frame.index})`;
    const decoded = Buffer.from(frame.data, "base64");
    if (decoded.length > payloadLimit) entry.invalid = `청크 페이로드 초과 (${decoded.length} > ${payloadLimit})`;
    if (decoded.toString("base64") !== frame.data) entry.invalid = "base64 왕복 불일치";
    entry.parts[frame.index] = decoded;
    entry.receivedBytes += decoded.length;
    entry.nextIndex = frame.index + 1;
    entry.complete = entry.nextIndex === entry.count;
    this.#chunks.set(frame.chunkId, entry);
    if (!entry.complete) return;
    if (entry.receivedBytes !== entry.byteLength) entry.invalid = `재조립 길이 불일치 (${entry.receivedBytes}/${entry.byteLength})`;
    const assembled = Buffer.concat(entry.parts).toString("utf8");
    entry.assembledBytes = Buffer.byteLength(assembled, "utf8");
    let parsed = null;
    try {
      parsed = JSON.parse(assembled);
    } catch {
      entry.invalid = "재조립 JSON 파싱 실패";
    }
    this.frames.push(parsed ?? { type: "rpc_chunk_unparsed", chunkId: frame.chunkId, bytes: assembled.length });
    if (isRecord(parsed) && parsed.type === "response" && typeof parsed.id === "string") {
      const pending = this.#pending.get(parsed.id);
      if (pending) {
        this.#pending.delete(parsed.id);
        clearTimeout(pending.timer);
        pending.resolve(parsed);
      }
    } else if (isRecord(parsed)) {
      this.events.push(parsed);
    }
  }

  send(command, { timeoutMs = 60000 } = {}) {
    const id = command.id ?? `req-${++this.#nextId}`;
    const payload = JSON.stringify({ ...command, id });
    this.#record("stdin", payload);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`응답 대기 초과: ${id} ${command.type}`));
      }, timeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
      this.#child.stdin.write(`${payload}\n`);
    });
  }

  /** 프로토콜 위반 관측용: JSON이 아닌 줄을 그대로 보낸다. */
  sendRaw(text) {
    this.#record("stdin", text);
    this.#child.stdin.write(`${text}\n`);
  }

  /** id를 되돌려주지 않는 실패 프레임까지 관측하기 위한 유예 대기. */
  async settle(ms) {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  async waitForFrame(predicate, { timeoutMs = 60000, description = "프레임" } = {}) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = this.frames.find(predicate);
      if (found) return found;
      if (Date.now() > deadline) throw new Error(`${description} 대기 초과 (${timeoutMs}ms)`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  async waitForEvent(predicate, { timeoutMs = 60000, description = "이벤트" } = {}) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = this.events.find(predicate);
      if (found) return found;
      if (Date.now() > deadline) throw new Error(`${description} 대기 초과 (${timeoutMs}ms)`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  eventTypes() {
    return this.events.map((event) => event.type);
  }

  responses() {
    return this.frames.filter((frame) => frame.type === "response");
  }

  chunkStats() {
    return [...this.#chunks.values()].map((entry) => ({
      chunkId: entry.chunkId,
      count: entry.count,
      declaredBytes: entry.byteLength,
      receivedBytes: entry.receivedBytes,
      assembledBytes: entry.assembledBytes ?? null,
      invalid: entry.invalid,
      complete: entry.complete === true,
    }));
  }

  async stop({ killTree = true, waitMs = 5000 } = {}) {
    if (!this.#child || this.#child.exitCode !== null) return;
    const pid = this.#child.pid;
    if (killTree && process.platform === "win32") {
      await new Promise((resolve) => {
        const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true });
        killer.on("exit", resolve);
        killer.on("error", resolve);
      });
    } else {
      this.#child.kill();
    }
    const deadline = Date.now() + waitMs;
    while (this.exit === null && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
  }

  alive() {
    return this.#child !== null && this.#child.exitCode === null && this.exit === null;
  }

  pid() {
    return this.#child?.pid ?? null;
  }
}
