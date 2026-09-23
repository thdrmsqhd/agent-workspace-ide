// TV-001 1단계: Theia 후보 호스트가 실제로 뜨고 확장이 배포되는지 확인한다.
// 헤드리스 Chrome을 CDP로만 조작하므로 사용자 마우스·키보드·창 포커스를 건드리지 않는다.
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { CdpPage } from "./cdp.mjs";
import { createIdeProbeWorkspace } from "./probe-workspace.mjs";

export const name = "tv-001";
export const verificationId = "TV-001";

const port = Number(process.env.AWI_THEIA_PORT ?? 3000);
const debugPort = Number(process.env.AWI_CDP_PORT ?? 9222);
const hostRoot = join(import.meta.dirname, "..", "..", "..", "apps", "ide-verification-host");

async function serverAlive() {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(4000) });
    return response.ok;
  } catch {
    return false;
  }
}

async function startServer(workspaceRoot, logPath) {
  const javaHome = process.env.AWI_JAVA_HOME ?? "C:/Users/gbsong/.jdks/jdk-21.0.12.1+1";
  // npx.cmd는 detached로 띄울 수 없다(EINVAL). 저장소에 설치된 theia CLI를 node로 직접 실행한다.
  const theiaBin = join(hostRoot, "node_modules", "@theia", "cli", "bin", "theia.js");
  const child = spawn(process.execPath, [theiaBin, "start", "--hostname", "127.0.0.1", `--port=${port}`, "--plugins=local-dir:plugins", workspaceRoot], {
    cwd: hostRoot,
    windowsHide: true,
    // Java 확장은 JDK 21 이상이 필요하다. 검증 호스트는 JDK 21을 명시해 띄운다.
    env: { ...process.env, JAVA_HOME: javaHome },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const chunks = [];
  child.stdout.on("data", (data) => chunks.push(data.toString()));
  child.stderr.on("data", (data) => chunks.push(data.toString()));
  child.unref();
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    if (await serverAlive()) return { started: true, chunks, child };
    await delay(2000);
  }
  writeFileSync(logPath, chunks.join(""));
  throw new Error(`백엔드 기동 실패: ${logPath}`);
}

function startChrome(profileDir) {
  const chrome = process.env.AWI_CHROME ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
  const child = spawn(
    chrome,
    [
      "--headless=new",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      `--user-data-dir=${profileDir}`,
      `--remote-debugging-port=${debugPort}`,
      `http://127.0.0.1:${port}/`,
    ],
    { windowsHide: true, detached: true, stdio: "ignore" },
  );
  child.unref();
  return child;
}

export async function run({ evidenceDir }) {
  const workspace = createIdeProbeWorkspace("hostboot");
  const rawDir = join(evidenceDir, "..", "..", "TV-001", "raw");
  mkdirSync(rawDir, { recursive: true });
  const result = {
    scenario: name,
    verificationId,
    hostRoot,
    probeWorkspace: workspace.root,
    backendPort: port,
    debugPort,
    criteria: [],
  };

  const logPath = join(rawDir, "backend.log");
  const alreadyUp = await serverAlive();
  const server = alreadyUp ? { started: false, chunks: [] } : await startServer(workspace.root, logPath);
  result.backendAlreadyRunning = alreadyUp;
  if (server.started) writeFileSync(logPath, server.chunks.join(""));
  const deployedCount = /Deploy batch of (\d+) accepted plugins/u.exec(server.chunks.join(""))?.[1] ?? null;
  result.deployedPlugins = deployedCount === null ? null : Number(deployedCount);
  result.criteria.push({
    id: "backend-serving",
    pass: await serverAlive(),
    detail: `프론트엔드 HTTP 응답 정상 (기존 실행=${alreadyUp})`,
  });

  const profileDir = join(tmpdir(), `awi-cdp-profile-${Date.now()}`);
  mkdirSync(profileDir, { recursive: true });
  startChrome(profileDir);
  const { page, target } = await CdpPage.attach({ port: debugPort, urlFilter: "127.0.0.1" });
  result.browserTarget = { url: target.url, title: target.title };
  await page.send("Page.enable");
  await page.enableConsoleCapture();

  try {
    await page.waitFor("document.readyState === 'complete'", { timeoutMs: 60000, description: "문서 로드" });
    // 최근 워크스페이스 복원에 의존하지 않고 검증 작업대를 URL로 직접 연다.
    const workspaceUrl = `http://127.0.0.1:${port}/#/${workspace.root.replace(/\\/gu, "/")}`;
    await page.send("Page.navigate", { url: workspaceUrl });
    await page.waitFor("document.readyState === 'complete'", { timeoutMs: 60000, description: "작업대 문서 로드" });
    result.workspaceUrl = workspaceUrl;
    const shell = await page.waitFor(
      "(() => { const el = document.querySelector('#theia-main-content-panel, .theia-app-shell'); return el ? true : false; })()",
      { timeoutMs: 180000, description: "Theia 앱 셸" },
    );
    result.criteria.push({ id: "workbench-shell", pass: shell === true, detail: "Theia 앱 셸 DOM 확인" });

    // 워크스페이스 신뢰 대화상자는 자동 조작으로만 처리한다(사용자 포커스 비침해).
    // "No, I don't trust the authors"가 먼저 잡히지 않도록 긍정 버튼만 고른다.
    const trustClicked = await page.evaluate(
      "(() => { const buttons = Array.from(document.querySelectorAll('button')); const target = buttons.find((button) => { const text = (button.textContent || '').trim(); return /^\\s*(yes|예)/iu.test(text) && /trust|신뢰/iu.test(text); }); if (!target) return false; target.click(); return true; })()",
    ).catch(() => false);
    result.trustDialogClicked = trustClicked;
    if (trustClicked) await delay(5000);

    // 탐색기가 준비되고 항목이 나올 때까지 기다린다.
    const explorer = await page
      .waitFor(
        "(() => { const text = document.body.innerText || ''; return text.includes('java-project') || text.includes('python-project'); })()",
        { timeoutMs: 120000, intervalMs: 1000, description: "탐색기 항목" },
      )
      .catch(() => false);
    result.criteria.push({ id: "explorer-lists-projects", pass: explorer === true, detail: explorer ? "탐색기에서 검증 프로젝트 확인" : "탐색기 항목 미확인" });

    const installed = await page.evaluate("(() => document.body.innerText.includes('vscode-icons') || document.body.innerText.includes('Java') )()").catch(() => false);
    result.browserShowsExtensionHint = installed;

    const shot = join(rawDir, "workbench.png");
    await page.screenshot(shot);
    result.screenshot = shot;
    result.consoleErrors = (await page.consoleErrors()).slice(0, 10);
    result.pageTitle = await page.evaluate("document.title");
    result.criteria.push({ id: "screenshot-captured", pass: true, detail: shot });
  } finally {
    page.close();
  }

  result.pass = result.criteria.every((criterion) => criterion.pass);
  return result;
}
