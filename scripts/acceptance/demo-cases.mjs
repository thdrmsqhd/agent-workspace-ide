#!/usr/bin/env node
/**
 * 제품 UI 사용 케이스 3종을 실제 앱에서 녹화한다: 우측 채널 · 파일 트리 · 채팅 입력.
 * - 창은 화면 밖 + 포커스 불가(검증 전용 패치)라 사용자 화면·포커스를 건드리지 않는다.
 * - 앱은 기본 프로필로 띄운다(격리 프로필에서는 제품 확장이 뜨지 않는 문제를 실측했다).
 *   대신 실행 전후에 제품 상태 디렉터리를 백업·복원해 사용자 데이터를 바꾸지 않는다.
 */
import { execFile, spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { connectPageSession } from "./lib/cdp.mjs";
import { assembleMp4, startRecording } from "./lib/recording.mjs";

const run = promisify(execFile);
const unpacked = join(process.env.LOCALAPPDATA, "Temp", "awi-ci-artifact", "win-unpacked");
const exe = join(unpacked, "Agent Workspace IDE.exe");
const port = 9229;
const stateDir = join(process.env.USERPROFILE ?? "", ".agent-workspace-ide");
const backupDir = join(process.env.LOCALAPPDATA, "Temp", "awi-state-backup");
const outDir = process.env.AWI_DEMO_OUT ?? join("docs", "evidence", "demo");
const framesDir = join(process.env.LOCALAPPDATA, "Temp", "awi-demo-frames");
const exists = (path) => stat(path).then(() => true, () => false);

const pace = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const setInput = (cdp, selector, value) => cdp.evaluate(`(() => {
  const element = document.querySelector(${JSON.stringify(selector)});
  if (!element) return "없음";
  const proto = element instanceof window.HTMLTextAreaElement ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value").set.call(element, ${JSON.stringify(value)});
  element.dispatchEvent(new Event("input", { bubbles: true }));
  element.dispatchEvent(new Event("change", { bubbles: true }));
  return element.value;
})()`);
const clickText = (cdp, text, scope = "button,a,[role=button]") => cdp.evaluate(`(() => {
  const element = [...document.querySelectorAll(${JSON.stringify(scope)})].find((item) => (item.innerText || "").trim() === ${JSON.stringify(text)});
  if (!element) return "없음";
  element.click();
  return "클릭";
})()`);
const clickContains = (cdp, text, scope) => cdp.evaluate(`(() => {
  const items = [...document.querySelectorAll(${JSON.stringify(scope)})].filter((item) => (item.innerText || "").includes(${JSON.stringify(text)}) && (item.innerText || "").length < 120);
  const element = items[0];
  if (!element) return "없음";
  element.click();
  return (element.innerText || "").trim().slice(0, 40);
})()`);
const typeSlow = async (cdp, selector, value) => {
  const step = Math.max(1, Math.ceil(value.length / 12));
  for (let end = step; end < value.length; end += step) {
    await setInput(cdp, selector, value.slice(0, end));
    await pace(40);
  }
  return setInput(cdp, selector, value);
};

// 1) 상태 백업
await run("taskkill", ["/IM", "Agent Workspace IDE.exe", "/T", "/F"]).catch(() => undefined);
await pace(1500);
const hadState = await exists(stateDir);
if (hadState) {
  await rm(backupDir, { recursive: true, force: true });
  await cp(stateDir, backupDir, { recursive: true });
}
process.stdout.write(`[백업] 제품 상태 ${hadState ? `${stateDir} → ${backupDir}` : "없음(신규)"}\n`);

// 2) 데모 저장소 준비
const root = await mkdtemp(join(tmpdir(), "awi-demo-"));
const repo = join(root, "demo-workspace");
await mkdir(join(repo, "src"), { recursive: true });
await writeFile(join(repo, "README.md"), "# 데모 저장소\n\n파일 트리 시연용 README입니다.\n");
await writeFile(join(repo, "src", "greet.ts"), "export function greet(name: string) {\n  return `안녕, ${name}`;\n}\n");
await writeFile(join(repo, "src", "app.ts"), "import { greet } from \"./greet\";\n\nexport const message = greet(\"에이전트\");\n");
for (const args of [["init", "-q", "-b", "main"], ["config", "user.name", "AWi"], ["config", "user.email", "at@example.invalid"], ["add", "."], ["commit", "-q", "-m", "base"]]) {
  await run("git", args, { cwd: repo });
}

// 3) 앱 기동
const child = spawn(exe, [repo], { cwd: unpacked, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
const logs = [];
child.stdout.on("data", (chunk) => logs.push(String(chunk)));
child.stderr.on("data", (chunk) => logs.push(String(chunk)));
const videos = [];
let cdp;
try {
  const deadline = Date.now() + 120_000;
  let version = null;
  while (Date.now() < deadline && !version) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) version = await response.json();
    } catch {
      // 아직
    }
    if (!version) await pace(1500);
  }
  if (!version?.webSocketDebuggerUrl) throw new Error("CDP 미응답");
  cdp = await connectPageSession(version.webSocketDebuggerUrl);
  await cdp.waitFor("document.body.innerText.includes('프로젝트 등록')", { timeoutMs: 120_000, intervalMs: 2000 });
  if (await cdp.evaluate("document.body.innerText.includes('Do you trust the authors')")) {
    await cdp.evaluate(`(() => { const b = [...document.querySelectorAll("button")].find((e) => (e.innerText||"").trim() === "Yes, I trust the authors"); if (b) b.click(); return "ok"; })()`);
    await pace(3000);
  }
  process.stdout.write("[앱] 대시보드 확인\n");

  await rm(framesDir, { recursive: true, force: true });
  let offset = 0;
  const segments = [];
  const record = async (name, action) => {
    const recorder = await startRecording(cdp, { dir: framesDir, offsetMs: offset, startIndex: segments.length, intervalMs: 130 });
    await pace(600);
    try {
      await action();
    } catch (error) {
      process.stdout.write(`[세그먼트 오류] ${name}: ${error instanceof Error ? error.message : String(error)}\n`);
    }
    await pace(800);
    const info = await recorder.stop();
    segments.push(...recorder.frames);
    offset += info.durationMs;
    if (recorder.frames.length === 0) {
      process.stdout.write(`[영상 건너뜀] ${name}: 프레임 없음(렌더러 무응답)\n`);
      return;
    }
    await mkdir(outDir, { recursive: true });
    const out = join(outDir, `${name}.mp4`);
    await assembleMp4({ frames: recorder.frames, outPath: out });
    videos.push(out.split("\\").join("/"));
    process.stdout.write(`[영상] ${out} (${recorder.frames.length}프레임)\n`);
  };

  // 데모 프로젝트 등록(제품 상태는 뒤에서 복원한다)
  const nameInput = "input[placeholder='프로젝트 이름']";
  const pathInput = "input[placeholder='Git 프로젝트 경로']";
  const modelInput = "input[placeholder='OMP 모델(provider/model)']";
  const branchInput = "input[placeholder='기준 브랜치']";
  await typeSlow(cdp, nameInput, "demo-workspace");
  await typeSlow(cdp, pathInput, repo);
  await typeSlow(cdp, modelInput, "openai-codex/gpt-5");
  await setInput(cdp, branchInput, "main");
  await pace(400);
  await clickText(cdp, "프로젝트 등록");
  await cdp.waitFor("document.body.innerText.includes('demo-workspace')", { timeoutMs: 60_000 });
  await pace(1500);

  if (process.argv.includes("--dump")) {
    await clickContains(cdp, "demo-workspace", ".awi-body aside *");
    await pace(3000);
    const structure = await cdp.evaluate(`(() => {
      const walk = (element, depth) => {
        if (depth > 4 || !element) return null;
        const text = (element.innerText || "").trim().replace(/\\n+/g, " | ").slice(0, 60);
        return {
          tag: element.tagName.toLowerCase(),
          cls: String(element.className || "").slice(0, 60),
          text,
          children: depth < 4 ? [...element.children].map((child) => walk(child, depth + 1)).filter(Boolean).slice(0, 12) : []
        };
      };
      const body = document.querySelector(".awi-body");
      const inputs = [...document.querySelectorAll(".awi-dashboard-root input, .awi-dashboard-root textarea, .awi-dashboard-root select, .awi-dashboard-root button")].map((e) => ({ tag: e.tagName.toLowerCase(), cls: String(e.className || "").slice(0, 40), ph: e.getAttribute("placeholder") || "", text: (e.innerText || "").trim().slice(0, 20) }));
      return { body: walk(body, 0), inputs };
    })()`);
    process.stdout.write(`${JSON.stringify(structure, null, 1).slice(0, 6000)}\n`);
    throw new Error("dump 모드 종료");
  }

  const safeEval = async (expression, attempts = 8) => {
    for (let index = 0; index < attempts; index++) {
      try {
        return await cdp.evaluate(expression);
      } catch {
        process.stdout.write(`[대기] 렌더러 응답 없음(${index + 1}/${attempts}) — 5초 후 재시도\n`);
        await pace(5000);
      }
    }
    return null;
  };

  // A. 우측 채널 이용: 프로젝트·세션 영역에서 프로젝트를 선택한다(선택하면 좌측 파일 패널이 그 프로젝트 파일을 보여준다).
  await record("demo-right-panel", async () => {
    const asideText = await safeEval(`(() => (document.querySelector("aside.awi-pane")?.innerText || "").replace(/\\n+/g, " | ").slice(0, 250))()`);
    process.stdout.write(`[우측 채널] ${String(asideText)}\n`);
    const clickedProject = await safeEval(`(() => { const items = [...document.querySelectorAll("aside.awi-pane *")].filter((e) => (e.innerText||"").includes("demo-workspace") && (e.innerText||"").length < 120); if (!items[0]) return "없음"; items[0].click(); return "클릭"; })()`);
    process.stdout.write(`[프로젝트 클릭] ${clickedProject}\n`);
    await pace(2500);
    const afterText = await safeEval(`(() => (document.querySelector("aside.awi-pane")?.innerText || "").replace(/\\n+/g, " | ").slice(0, 250))()`);
    process.stdout.write(`[선택 후] ${String(afterText)}\n`);
    await pace(1500);
  });

  // B. 파일 트리 이용: 좌측 파일 패널에서 폴더를 펼치고 파일을 연다(비어 있으면 워크스페이스 탐색기를 쓴다).
  await record("demo-file-tree", async () => {
    const paneText = await safeEval(`(() => (document.querySelector("section.awi-pane")?.innerText || "").replace(/\\n+/g, " | ").slice(0, 200))()`);
    process.stdout.write(`[파일 패널] ${String(paneText)}\n`);
    const finder = `(() => {
      const scopes = ["section.awi-pane", ".theia-TreeNodeContent", "[class*=TreeNodeContent]"];
      for (const scope of scopes) {
        for (const element of document.querySelectorAll(scope + (scope.indexOf("[") === 0 ? "" : " *"))) {
          const text = (element.innerText || "").trim();
          if (text === "src") { element.click(); return "src 클릭"; }
        }
      }
      return "src 없음";
    })()`;
    const expand = await safeEval(finder);
    process.stdout.write(`[폴더] ${expand}\n`);
    await pace(1800);
    const openFile = await safeEval(`(() => {
      const scopes = ["section.awi-pane *", ".theia-TreeNodeContent", "[class*=TreeNodeContent]"];
      for (const scope of scopes) {
        for (const element of document.querySelectorAll(scope)) {
          const text = (element.innerText || "").trim();
          if (text === "greet.ts" || text === "README.md") { element.click(); return text + " 클릭"; }
        }
      }
      return "파일 없음";
    })()`);
    process.stdout.write(`[파일] ${openFile}\n`);
    await pace(2500);
    const editor = await safeEval(`({ hasEditor: Boolean(document.querySelector(".theia-editor")), text: (document.querySelector(".theia-editor")?.innerText || "").slice(0, 100), pane: (document.querySelector("section.awi-pane")?.innerText || "").replace(/\\n+/g, " | ").slice(0, 120) })`);
    process.stdout.write(`[결과] ${JSON.stringify(editor)}\n`);
    await pace(800);
  });

  // C. 채팅 입력 이용: 새 요청 입력에 요청을 작성한다(전송은 에이전트 기동을 유발하므로 데모에서는 입력까지).
  await record("demo-chat-input", async () => {
    const typed = await safeEval(`(() => {
      const element = document.querySelector("input[placeholder='새 요청']");
      if (!element) return "없음";
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
      const text = "src/greet.ts에 인사말 함수 설명을 주석으로 추가해줘";
      for (let end = 1; end <= text.length; end++) setter.call(element, text.slice(0, end));
      element.dispatchEvent(new Event("input", { bubbles: true }));
      return element.value;
    })()`);
    process.stdout.write(`[입력] ${String(typed).slice(0, 60)}\n`);
    await pace(2000);
  });
} finally {
  if (cdp) cdp.close();
  await run("taskkill", ["/IM", "Agent Workspace IDE.exe", "/T", "/F"]).catch(() => undefined);
  await pace(2500);
  // 4) 상태 복원
  if (hadState) {
    await rm(stateDir, { recursive: true, force: true });
    await cp(backupDir, stateDir, { recursive: true });
    process.stdout.write(`[복원] ${stateDir} ← ${backupDir}\n`);
  } else {
    await rm(stateDir, { recursive: true, force: true });
    process.stdout.write("[복원] 실행 전 상태가 없어 새로 만든 상태를 제거\n");
  }
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  process.stdout.write(`${videos.join("\n")}\n`);
}
