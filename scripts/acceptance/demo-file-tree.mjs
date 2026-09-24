#!/usr/bin/env node
/**
 * 파일 트리 사용 케이스 녹화: 제품의 좌측 파일 패널(aside.awi-files)은 '파일을 볼 작업'이 있어야 채워진다.
 * 작업을 UI로 새로 만들면 렌더러가 멈추므로(실측), 제품 API(StateStore)로 데이터를 미리 넣고
 * 앱은 AWI_DATA_DIR로 데이터만 격리해 띄운다(사용자 상태·Theia 프로필은 건드리지 않는다).
 */
import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, stat, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import process from "node:process";
import { promisify } from "node:util";

import { connectPageSession } from "./lib/cdp.mjs";
import { assembleMp4, startRecording } from "./lib/recording.mjs";

const run = promisify(execFile);
const root = process.env.AWI_REPO_ROOT ?? join(process.cwd());
const unpacked = join(process.env.LOCALAPPDATA, "Temp", "awi-ci-artifact", "win-unpacked");
const exe = join(unpacked, "Agent Workspace IDE.exe");
const port = 9229;
const outDir = join(root, "docs", "evidence", "demo");
const pace = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const log = [];
let cdp;
let child;
let temp;

const note = (message) => {
  log.push({ atMs: Date.now() - startedAt, text: message });
  process.stdout.write(`[단계] ${message}\n` + "\n");
};

const startedAt = Date.now();
await run("taskkill", ["/IM", "Agent Workspace IDE.exe", "/T", "/F"]).catch(() => undefined);
await pace(1500);

try {
  // 1) 임시 데이터 디렉터리 + 데모 저장소(제품 상태와 분리)
  temp = await mkdtemp(join(tmpdir(), "awi-filetree-"));
  const dataDir = join(temp, "data");
  const repo = join(temp, "demo-repository");
  await mkdir(join(repo, "src"), { recursive: true });
  await mkdir(join(repo, "docs"), { recursive: true });
  await writeFile(join(repo, "README.md"), "# 데모 저장소\n\n파일 트리 시연용입니다.\n");
  await writeFile(join(repo, "src", "greet.ts"), "export const greeting = \"안녕하세요\";\n");
  await writeFile(join(repo, "src", "model.ts"), "export interface Row { readonly id: string }\n");
  await writeFile(join(repo, "docs", "notes.md"), "# 메모\n");
  for (const args of [["init", "-q", "-b", "main"], ["config", "user.name", "AWi"], ["config", "user.email", "at@example.invalid"], ["add", "."], ["commit", "-q", "-m", "base"]]) {
    await run("git", args, { cwd: repo });
  }

  // 2) 제품 API로 프로젝트 + 논의 작업을 데이터에 넣는다(UI 조작 없이).
  //    스키마가 앱 번들과 정확히 같도록 앱에 포함된 @awi 모듈을 그대로 쓴다.
  const appModules = join(unpacked, "resources", "app", "node_modules");
  const { pathToFileURL } = await import("node:url");
  const { StateStore } = await import(pathToFileURL(join(appModules, "@awi", "persistence", "dist", "index.js")).href);
  const { inspectRepository } = await import(pathToFileURL(join(appModules, "@awi", "worktrees", "dist", "index.js")).href);
  const store = await StateStore.open(join(dataDir, "state.sqlite"));
  const repoInfo = await inspectRepository(repo);
  const projectId = store.createProject("file-tree-demo", repoInfo.repoPath, repoInfo.repoKey, "main");
  store.saveSettingsSnapshot("project", projectId, { engine: "omp", model: "openai-codex/gpt-5", mode: "manual" });
  const taskId = store.createDiscussion(projectId, "파일 트리에서 소스를 열어 보는 시연");
  process.stdout.write(`프로젝트 ${projectId} · 작업 ${taskId} · 저장소 목록 ${store.listProjects().length}개 · 작업 목록 ${store.listTasks().length}개` + "\n");

  // 3) 앱 기동(AWI_DATA_DIR만 격리)
  child = spawn(exe, [repo], {
    cwd: unpacked,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    env: { ...process.env, AWI_DATA_DIR: dataDir },
  });
  child.stdout.on("data", () => undefined);
  child.stderr.on("data", () => undefined);

  const deadline = Date.now() + 120_000;
  let version = null;
  while (Date.now() < deadline && !version) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) version = await response.json();
    } catch {
      // 아직 준비 전
    }
    if (!version) await pace(1500);
  }
  if (!version) throw new Error("CDP 엔드포인트를 찾지 못했습니다.");
  cdp = await connectPageSession(version.webSocketDebuggerUrl);
  await cdp.waitFor("document.body.innerText.includes('프로젝트')", { timeoutMs: 120_000, intervalMs: 2000 });
  await pace(2000);

  const framesDir = join(temp, "frames");
  await mkdir(framesDir, { recursive: true });
  const frames = [];
  const recorder = await startRecording(cdp, { dir: framesDir, intervalMs: 130 });
  const step = async (text, action, wait = 1600) => {
    note(text);
    await action();
    await pace(wait);
  };

  await step("앱 실행: 제품 대시보드가 열렸습니다", async () => undefined, 1200);

  const cardState = await cdp.evaluate(`(() => {
    const cards = [...document.querySelectorAll("article.awi-card")];
    return JSON.stringify({ cards: cards.length, prompts: cards.map((c) => (c.querySelector(".awi-original-request")?.innerText || "").slice(0, 30)) });
  })()`);
  process.stdout.write(`작업 카드: ${cardState}` + "\n");

  await step("전체 현황에서 작업 카드를 엽니다", async () => {
    const clicked = await cdp.evaluate(`(() => {
      const button = [...document.querySelectorAll("article.awi-card button")].find((element) => (element.innerText || "").trim() === "작업 열기");
      if (!button) return "작업 열기 버튼 없음";
      button.click();
      return "작업 열기 클릭";
    })()`);
    process.stdout.write(clicked);
  }, 3000);

  const filesState = await cdp.evaluate(`(() => {
    const panel = document.querySelector("aside.awi-files");
    const items = [...(panel?.querySelectorAll("ul.awi-file-list li button") ?? [])].map((e) => (e.innerText || "").trim());
    return JSON.stringify({ title: (panel?.querySelector("h2")?.innerText || "").slice(0, 40), count: items.length, items: items.slice(0, 8) });
  })()`);
  process.stdout.write(`파일 패널: ${filesState}` + "\n");

  await step("좌측 파일 패널에 저장소 파일 목록이 나타납니다", async () => undefined, 2000);

  await step("파일 트리에서 src/greet.ts를 열어 편집기에 표시합니다", async () => {
    const opened = await cdp.evaluate(`(() => {
      const buttons = [...document.querySelectorAll("aside.awi-files ul.awi-file-list li button")];
      const target = buttons.find((element) => (element.innerText || "").includes("src/greet.ts"));
      if (!target) return "파일 항목 없음";
      target.click();
      return "src/greet.ts 클릭";
    })()`);
    process.stdout.write(opened);
  }, 3500);

  const editorState = await cdp.evaluate(`(() => {
    const editor = document.querySelector(".theia-editor, .monaco-editor");
    return JSON.stringify({ editor: Boolean(editor), text: (document.querySelector(".monaco-editor")?.innerText || "").replace(/\\n+/g, " ").slice(0, 80) });
  })()`);
  process.stdout.write(`편집기: ${editorState}` + "\n");

  await step("편집기에 파일 내용이 표시됩니다", async () => undefined, 2500);

  const info = await recorder.stop();
  frames.push(...recorder.frames);
  if (frames.length === 0) throw new Error("녹화된 프레임이 없습니다.");
  await mkdir(outDir, { recursive: true });
  const outPath = join(outDir, "demo-file-tree.mp4");
  const captions = log.map((entry, index) => ({ atMs: entry.atMs, text: entry.text, index }));
  await assembleMp4({ frames, outPath, fps: 8, width: Number(info.width ?? 1280), captions });
  process.stdout.write(`[영상] ${relative(root, outPath)} (${frames.length}프레임)` + "\n");
} catch (error) {
  process.stdout.write(`[실패] ${error instanceof Error ? error.message : String(error)}\n` + "\n");
  process.exitCode = 1;
} finally {
  if (cdp) cdp.close();
  await run("taskkill", ["/IM", "Agent Workspace IDE.exe", "/T", "/F"]).catch(() => undefined);
  await pace(2000);
  if (temp) await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => undefined);
  const stateFile = join(process.env.USERPROFILE ?? "", ".agent-workspace-ide", "state.sqlite");
  const state = await stat(stateFile).then((info) => info.size, () => -1);
  process.stdout.write(`사용자 상태 파일 크기: ${state} (건드리지 않음)` + "\n");
  const files = await readdir(join(root, "docs", "evidence", "demo")).catch(() => []);
  process.stdout.write(`증거 폴더: ${files.join(", ")}` + "\n");
}