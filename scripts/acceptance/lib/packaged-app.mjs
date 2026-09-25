#!/usr/bin/env node
// CI 패키지 앱(win-unpacked) 준비·구동 도구.
// - 준비: app.asar를 풀어 resources/app으로 만들고 창을 화면 밖·포커스 불가로 바꾼다(검증 전용, 산출물 사본에만).
// - 구동: AWI_DATA_DIR로 제품 데이터만 임시 폴더로 격리해 사용자의 실제 상태(~/.agent-workspace-ide)를 건드리지 않는다(Theia 프로필은 그대로 둔다).
import { execFile, spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { connectPageSession } from "./cdp.mjs";

const run = promisify(execFile);
const exists = (path) => stat(path).then(() => true, () => false);

export function packagedAppPaths(artifactRoot = join(process.env.LOCALAPPDATA, "Temp", "awi-ci-artifact")) {
  const unpacked = join(artifactRoot, "win-unpacked");
  const resources = join(unpacked, "resources");
  return {
    artifactRoot,
    unpacked,
    exe: join(unpacked, "Agent Workspace IDE.exe"),
    resources,
    archive: join(resources, "app.asar"),
    origin: join(resources, "app.asar.awi-origin"),
    app: join(resources, "app"),
    main: join(resources, "app", "lib", "backend", "electron-main.js"),
  };
}

/** 창을 화면 밖·포커스 불가로 바꾸고 CDP 포트를 주입한다. 여러 번 호출해도 안전하다. */
export async function preparePackagedApp({ artifactRoot, port = 9229, repo = process.cwd() } = {}) {
  const paths = packagedAppPaths(artifactRoot);
  if (!(await exists(paths.archive)) && !(await exists(paths.origin))) {
    throw new Error(`패키지 앱을 찾지 못했습니다: ${paths.archive}`);
  }
  if (!(await exists(paths.app))) {
    const require = createRequire(join(repo, "apps", "desktop", "package.json"));
    const asar = require("@electron/asar");
    await asar.extractAll(paths.archive, paths.app);
    if (!(await exists(paths.origin))) await rename(paths.archive, paths.origin);
  }
  const pristine = await readFile(paths.main, "utf8");
  const windowOptions = 'windowOptions:{"focusable":false,"skipTaskbar":true,"x":-32000,"y":-32000}';
  const body = pristine.startsWith("try{require(\"electron\")")
    ? pristine
    : `try{require("electron").app.commandLine.appendSwitch("remote-debugging-port","${port}");}catch{}\n${pristine}`;
  const patched = body
    .split('windowOptions:{"focusable":false,"skipTaskbar":true,"x":-32000,"y":-32000}').join(windowOptions)
    .split("windowOptions:{}").join(windowOptions);
  await writeFile(paths.main, patched, "utf8");
  return { ...paths, offscreenWindows: (patched.match(/"focusable":false/g) ?? []).length };
}

/** 격리된 홈에서 패키지 앱을 띄우고 페이지 세션을 붙인다. */
export async function launchPackagedApp({ home, artifactRoot, port = 9229, repo = process.cwd(), timeoutMs = 180_000, workspace } = {}) {
  if (!home) throw new Error("격리할 홈 디렉터리(home)가 필요합니다.");
  const paths = await preparePackagedApp({ artifactRoot, port, repo });
  // Electron은 APPDATA/LOCALAPPDATA 디렉터리가 없으면 기동 중 크래시한다(0x80000003). 먼저 만든다.
  await mkdir(join(home, "AppData", "Roaming"), { recursive: true });
  await mkdir(join(home, "AppData", "Local"), { recursive: true });
  // 단일 인스턴스 잠금 때문에 이전 실행이 남아 있으면 새 창이 즉시 종료된다.
  await run("taskkill", ["/IM", "Agent Workspace IDE.exe", "/T", "/F"], { cwd: repo }).catch(() => undefined);
  await new Promise((resolve) => setTimeout(resolve, 1500));

  const logs = [];
  const child = spawn(paths.exe, workspace ? [workspace] : [], {
    cwd: paths.unpacked,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    // 제품 데이터만 AWI_DATA_DIR로 격리한다. USERPROFILE까지 바꾸면 Theia 프로필이 새로 만들어져
    // 제품 확장이 렌더되지 않는다(대시보드 미표시로 실측).
    env: { ...process.env, AWI_DATA_DIR: join(home, "product-data") },
  });
  child.stdout.on("data", (chunk) => logs.push(String(chunk)));
  child.stderr.on("data", (chunk) => logs.push(String(chunk)));
  child.on("exit", (code, signal) => logs.push(`[harness] 앱 종료 code=${code} signal=${signal}\n`));

  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await run("taskkill", ["/PID", String(child.pid), "/T", "/F"]).catch(() => undefined);
    await run("taskkill", ["/IM", "Agent Workspace IDE.exe", "/T", "/F"]).catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 2500));
  };

  try {
    const deadline = Date.now() + timeoutMs;
    let version = null;
    let lastCdpError = "없음";
    while (Date.now() < deadline && !version) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/json/version`);
        if (response.ok) version = await response.json();
        else lastCdpError = `HTTP ${response.status}`;
      } catch (error) {
        lastCdpError = error instanceof Error ? error.message : String(error);
      }
      if (!version) await new Promise((resolve) => setTimeout(resolve, 1500));
    }
    if (!version?.webSocketDebuggerUrl) {
      throw new Error(`CDP 미응답(마지막 오류: ${lastCdpError}). 로그: ${logs.join("").slice(-1200)}`);
    }
    const cdp = await connectPageSession(version.webSocketDebuggerUrl);
    await cdp.waitFor("document.querySelectorAll('*').length > 120", { timeoutMs: 120_000, intervalMs: 2000 });
    return { cdp, logs, close, port, home, exe: paths.exe };
  } catch (error) {
    await close();
    throw error;
  }
}

/** 제품 상태 DB 경로(격리 홈 기준). */
export function statePath(home) {
  return join(home, ".agent-workspace-ide", "state.sqlite");
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  if (process.argv.includes("--restore")) {
    const paths = packagedAppPaths();
    await rm(paths.app, { recursive: true, force: true });
    if (await exists(paths.origin)) await rename(paths.origin, paths.archive);
    process.stdout.write(`복원: ${(await exists(paths.archive)) ? "app.asar 되돌림" : "app.asar 없음(확인 필요)"}\n`);
  } else {
    const prepared = await preparePackagedApp();
    process.stdout.write(`준비 완료: ${dirname(prepared.main)} (오프스크린 창 ${prepared.offscreenWindows}곳)\n`);
  }
}
