#!/usr/bin/env node
// 일회성 정찰 3: 기본 프로필로 앱을 띄워 대시보드·파일트리·우측 채널·입력 DOM을 파악한다.
import { execFile, spawn } from "node:child_process";
import { join } from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { connectPageSession } from "./cdp.mjs";

const run = promisify(execFile);
const exe = join(process.env.LOCALAPPDATA, "Temp", "awi-ci-artifact", "win-unpacked", "Agent Workspace IDE.exe");
const port = 9229;

const workspace = process.env.AWI_DEMO_WORKSPACE;
await run("taskkill", ["/IM", "Agent Workspace IDE.exe", "/T", "/F"]).catch(() => undefined);
await new Promise((r) => setTimeout(r, 1500));
const child = spawn(exe, workspace ? [workspace] : [], { cwd: join(process.env.LOCALAPPDATA, "Temp", "awi-ci-artifact", "win-unpacked"), stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
child.stdout.on("data", () => {});
child.stderr.on("data", () => {});

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
    if (!version) await new Promise((r) => setTimeout(r, 1500));
  }
  if (!version?.webSocketDebuggerUrl) throw new Error("CDP 미응답");
  const cdp = await connectPageSession(version.webSocketDebuggerUrl);
  try {
    await cdp.waitFor("document.body.innerText.includes('프로젝트 등록')", { timeoutMs: 90_000, intervalMs: 2000 });
    process.stdout.write("대시보드 확인 ✓\n");
  } catch (error) {
    const state = await cdp.evaluate(`({ title: document.title, text: (document.body.innerText||"").replace(/\\n{2,}/g,"\\n").slice(0,400), elements: document.querySelectorAll("*").length })`);
    process.stdout.write(`대시보드 없음: ${JSON.stringify(state)}\n`);
    throw error;
  }
  if (await cdp.evaluate("document.body.innerText.includes('Do you trust the authors')")) {
    await cdp.evaluate(`(() => { const b = [...document.querySelectorAll("button")].find((e) => (e.innerText||"").trim() === "Yes, I trust the authors"); if (b) { b.click(); return "clicked"; } return "none"; })()`);
    await new Promise((r) => setTimeout(r, 3000));
  }
  const dump = await cdp.evaluate(`(() => {
    const describe = (element) => ({ tag: element.tagName.toLowerCase(), text: (element.innerText || "").trim().replace(/\\n+/g, " | ").slice(0, 45), cls: String(element.className || "").slice(0, 50), id: element.id || "", ph: element.getAttribute("placeholder") || "", title: element.getAttribute("title") || "" });
    return {
      inputs: [...document.querySelectorAll("input,textarea")].map(describe),
      treeItems: [...document.querySelectorAll("#shell-tab-explorer-widget .theia-TreeNodeContent, .theia-TreeNodeContent")].slice(0, 20).map(describe),
      treeRowTexts: [...document.querySelectorAll("[class*=TreeNode]")].map((e) => (e.innerText || "").trim()).filter((t) => t && t.length < 40).slice(0, 20),
      buttons: [...document.querySelectorAll("button")].map(describe).slice(0, 20),
      rightPanelText: [...document.querySelectorAll(".awi-body > *")].map((e) => (e.innerText || "").trim().replace(/\\n+/g, " | ").slice(0, 160)).slice(0, 6),
      tabLabels: [...document.querySelectorAll(".lm-TabBar-tabLabel")].map((e) => (e.innerText || "").trim()).slice(0, 10)
    };
  })()`);
  process.stdout.write(`${JSON.stringify(dump, null, 1).slice(0, 3200)}\n`);
  // 파일 트리 첫 항목 클릭 → 에디터가 열리는지 확인(상태 변경 없음)
  const clicked = await cdp.evaluate(`(() => { const item = [...document.querySelectorAll(".theia-TreeNodeContent")].find((e) => (e.innerText || "").trim().length > 0); if (!item) return "항목 없음"; item.click(); return (item.innerText || "").trim().slice(0, 40); })()`);
  process.stdout.write(`[트리 클릭] ${clicked}\n`);
  await new Promise((r) => setTimeout(r, 5000));
  const after = await cdp.evaluate(`({ hasEditor: Boolean(document.querySelector(".theia-editor")), tabs: [...document.querySelectorAll(".lm-TabBar-tabLabel")].map((e) => (e.innerText || "").trim()).slice(0, 10), editorText: (document.querySelector(".theia-editor")?.innerText || "").slice(0, 200) })`);
  process.stdout.write(`[클릭 후] ${JSON.stringify(after)}\n`);
  await cdp.screenshot(join(process.env.LOCALAPPDATA, "Temp", "vcheck", "real-home.png"));
  cdp.close();
} finally {
  await run("taskkill", ["/IM", "Agent Workspace IDE.exe", "/T", "/F"]).catch(() => undefined);
}
