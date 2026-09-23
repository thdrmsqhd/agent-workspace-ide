// 최소 CDP 클라이언트: Node 24 내장 WebSocket만 사용한다.
// 헤드리스 Chrome을 원격 디버깅으로 조작하며 사용자 창 포커스를 건드리지 않는다.
import { setTimeout as delay } from "node:timers/promises";
import process from "node:process";

export class CdpPage {
  #ws = null;
  #nextId = 0;
  #pending = new Map();
  #listeners = new Map();

  static async attach({ port = 9222, urlFilter = "127.0.0.1:3000", timeoutMs = 120000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    let target = null;
    while (Date.now() < deadline) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/json/list`);
        const targets = await response.json();
        target = targets.find((entry) => entry.type === "page" && entry.url.includes(urlFilter)) ?? targets.find((entry) => entry.type === "page");
        if (target?.webSocketDebuggerUrl) break;
      } catch {
        // 아직 디버깅 포트가 열리지 않았다.
      }
      await delay(500);
    }
    if (!target?.webSocketDebuggerUrl) throw new Error("CDP 페이지 대상 발견 실패");
    const page = new CdpPage();
    await page.#connect(target.webSocketDebuggerUrl);
    return { page, target };
  }

  #connect(url) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      this.#ws = ws;
      ws.addEventListener("open", () => resolve());
      ws.addEventListener("error", (event) => reject(new Error(`WebSocket 오류: ${event.message ?? "unknown"}`)));
      ws.addEventListener("message", (event) => {
        let message;
        try {
          message = JSON.parse(event.data);
        } catch {
          return;
        }
        if (message.id !== undefined && this.#pending.has(message.id)) {
          const { resolve: resolvePending, reject: rejectPending } = this.#pending.get(message.id);
          this.#pending.delete(message.id);
          if (message.error) rejectPending(new Error(`${message.error.message} (${message.error.code})`));
          else resolvePending(message.result);
          return;
        }
        const handlers = this.#listeners.get(message.method) ?? [];
        for (const handler of handlers) handler(message.params);
      });
    });
  }

  on(method, handler) {
    this.#listeners.set(method, [...(this.#listeners.get(method) ?? []), handler]);
  }

  send(method, params = {}) {
    const id = ++this.#nextId;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression, { awaitPromise = true } = {}) {
    const result = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise });
    if (result.exceptionDetails) throw new Error(`평가 예외: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`);
    return result.result?.value;
  }

  async waitFor(expression, { timeoutMs = 120000, intervalMs = 500, description = expression } = {}) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const value = await this.evaluate(expression).catch(() => undefined);
      if (value) return value;
      if (Date.now() > deadline) throw new Error(`조건 대기 초과: ${description}`);
      await delay(intervalMs);
    }
  }

  async screenshot(path) {
    const shot = await this.send("Page.captureScreenshot", { format: "png" });
    const { writeFileSync } = await import("node:fs");
    writeFileSync(path, Buffer.from(shot.data, "base64"));
    return path;
  }

  async consoleErrors() {
    return this.#consoleErrors ?? [];
  }

  async enableConsoleCapture() {
    this.#consoleErrors = [];
    await this.send("Runtime.enable");
    this.on("Runtime.consoleAPICalled", (params) => {
      if (params.type === "error") this.#consoleErrors.push(params.args.map((arg) => arg.value ?? arg.description ?? "").join(" ").slice(0, 300));
    });
  }

  #consoleErrors = [];

  close() {
    this.#ws?.close();
  }
}

export function chromeBinary() {
  const candidates =
    process.platform === "win32"
      ? ["C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"]
      : ["google-chrome", "chromium"];
  return candidates[0];
}
