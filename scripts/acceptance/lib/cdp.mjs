import { writeFile } from "node:fs/promises";

/** CDP 한 엔드포인트에 붙어 명령을 보내는 최소 클라이언트. Node 24의 전역 WebSocket을 쓴다. */
export async function connectCdp(webSocketDebuggerUrl, { timeoutMs = 20_000 } = {}) {
  const socket = new WebSocket(webSocketDebuggerUrl);
  const pending = new Map();
  const listeners = new Map();
  let nextId = 1;

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("CDP 연결 시간 초과")), timeoutMs);
    socket.addEventListener("open", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
    socket.addEventListener("error", (event) => {
      clearTimeout(timer);
      reject(new Error(`CDP 연결 실패: ${event?.message ?? "error"}`));
    }, { once: true });
  });

  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    if (message.id && pending.has(message.id)) {
      const settle = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) settle.reject(new Error(`${message.error.message} (${message.error.code})`));
      else settle.resolve(message.result);
      return;
    }
    if (message.method) {
      for (const handler of listeners.get(message.method) ?? []) handler(message.params, message.sessionId);
    }
  });

  socket.addEventListener("close", () => {
    for (const [, settle] of pending) settle.reject(new Error("CDP 소켓이 닫혔습니다."));
    pending.clear();
  });

  const send = (method, params = {}, options = {}) => new Promise((resolve, reject) => {
    const id = nextId++;
    const commandTimeout = options.timeoutMs ?? 30_000;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`CDP 명령 시간 초과(${commandTimeout}ms): ${method}`));
    }, commandTimeout);
    pending.set(id, {
      resolve: (value) => { clearTimeout(timer); resolve(value); },
      reject: (error) => { clearTimeout(timer); reject(error); },
    });
    try {
      const payload = { id, method, params };
      if (options.sessionId) payload.sessionId = options.sessionId;
      socket.send(JSON.stringify(payload));
    } catch (error) {
      clearTimeout(timer);
      pending.delete(id);
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });

  const evaluate = async (expression, { awaitPromise = true, sessionId } = {}) => {
    const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise }, sessionId ? { sessionId } : {});
    if (result.exceptionDetails) {
      const text = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text;
      throw new Error(`페이지 평가 실패: ${text}`);
    }
    return result.result.value;
  };

  const waitFor = async (expression, { timeoutMs: waitMs = 60_000, intervalMs = 500, sessionId } = {}) => {
    const deadline = Date.now() + waitMs;
    let last;
    while (Date.now() < deadline) {
      try {
        last = await evaluate(expression, { sessionId });
        if (last) return last;
      } catch (error) {
        last = error instanceof Error ? error.message : String(error);
      }
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
    throw new Error(`조건 대기 시간 초과(${waitMs}ms): ${expression} (마지막 값: ${JSON.stringify(last)})`);
  };

  const screenshot = async (path, { fullPage = false, sessionId } = {}) => {
    const options = sessionId ? { sessionId } : {};
    if (fullPage) {
      const metrics = await send("Page.getLayoutMetrics", {}, options);
      const size = metrics.cssContentSize ?? metrics.contentSize;
      await send("Emulation.setDeviceMetricsOverride", {
        width: Math.ceil(size.width), height: Math.ceil(size.height), deviceScaleFactor: 1, mobile: false,
      }, options);
    }
    const shot = await send("Page.captureScreenshot", { format: "png" }, options);
    await writeFile(path, Buffer.from(shot.data, "base64"));
    if (fullPage) await send("Emulation.clearDeviceMetricsOverride", {}, options);
    return path;
  };

  return {
    send,
    evaluate,
    waitFor,
    screenshot,
    on: (method, handler) => {
      const handlers = listeners.get(method) ?? [];
      handlers.push(handler);
      listeners.set(method, handlers);
      return () => listeners.set(method, (listeners.get(method) ?? []).filter((item) => item !== handler));
    },
    close: () => socket.close(),
  };
}

/**
 * 브라우저 엔드포인트에 붙어 페이지 타깃에 세션으로 연결한다.
 * 페이지별 엔드포인트가 응답하지 않는 호스트(Electron)에서도 동작하는 경로다.
 */
export async function connectPageSession(browserWebSocketDebuggerUrl, { timeoutMs = 20_000, prefer = ["page", "webview", "iframe"] } = {}) {
  const base = await connectCdp(browserWebSocketDebuggerUrl, { timeoutMs });
  const { targetInfos } = await base.send("Target.getTargets");
  const target = prefer.map((type) => targetInfos.find((info) => info.type === type)).find(Boolean);
  if (!target) {
    throw new Error(`연결할 페이지 타깃이 없습니다: ${JSON.stringify(targetInfos.map((info) => `${info.type}:${info.url}`))}`);
  }
  const attached = await base.send("Target.attachToTarget", { targetId: target.targetId, flatten: true });
  const sessionId = attached.sessionId;
  return {
    sessionId,
    targetInfo: target,
    send: (method, params = {}, options = {}) => base.send(method, params, { ...options, sessionId }),
    evaluate: (expression, options = {}) => base.evaluate(expression, { ...options, sessionId }),
    waitFor: (expression, options = {}) => base.waitFor(expression, { ...options, sessionId }),
    screenshot: (path, options = {}) => base.screenshot(path, { ...options, sessionId }),
    close: () => base.close(),
  };
}
