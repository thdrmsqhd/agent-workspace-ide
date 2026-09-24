#!/usr/bin/env node
// 일회성 정찰 2: 대시보드 로딩을 기다린 뒤 파일 트리·우측 채널·채팅 입력 구조를 파악한다.
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { launchPackagedApp } from "./packaged-app.mjs";

const run = promisify(execFile);
const root = await mkdtemp(join(tmpdir(), "awi-recon2-"));
const repo = join(root, "recon-repo");
const home = join(root, "home");
await mkdir(join(repo, "src"), { recursive: true });
await writeFile(join(repo, "README.md"), "# 정찰 저장소\n\n파일 트리 시연용입니다.\n");
await writeFile(join(repo, "src", "main.ts"), "export const answer = 42;\n");
for (const args of [["init", "-b", "main"], ["config", "user.name", "AWi"], ["config", "user.email", "at@example.invalid"], ["add", "."], ["commit", "-m", "base"]]) {
  await run("git", args, { cwd: repo });
}

let active = await launchPackagedApp({ home, port: 9229 });
try {
  let cdp = active.cdp;
  if (!(await cdp.evaluate("document.body.innerText.includes('프로젝트 등록')"))) {
    await active.close();
    active = await launchPackagedApp({ home, port: 9229, workspace: repo });
    cdp = active.cdp;
  }
  await new Promise((r) => setTimeout(r, 4000));
  // 신뢰 모달은 뜨는 시점이 일정하지 않다. 사라질 때까지 반복해서 닫는다.
  for (let attempt = 0; attempt < 10; attempt++) {
    if (!(await cdp.evaluate("document.body.innerText.includes('Do you trust the authors')"))) break;
    const clicked = await cdp.evaluate(`(() => { const b = [...document.querySelectorAll("button,a,[role=button]")].find((e) => (e.innerText||"").trim() === "Yes, I trust the authors"); if (b) { b.click(); return "clicked"; } return "none"; })()`);
    process.stdout.write(`[신뢰 모달] ${clicked}\n`);
    await new Promise((r) => setTimeout(r, 2500));
  }
  const events = [];
  cdp.on("Runtime.consoleAPICalled", (params) => events.push(`console.${params.type}: ${(params.args ?? []).map((a) => String(a.value ?? a.description ?? "")).join(" ").slice(0, 160)}`));
  cdp.on("Log.entryAdded", (params) => events.push(`log.${params.entry?.level}: ${String(params.entry?.text ?? "").slice(0, 160)}`));
  await cdp.send("Runtime.enable").catch(() => undefined);
  await cdp.send("Log.enable").catch(() => undefined);
  try {
    await cdp.waitFor("document.body.innerText.includes('프로젝트 등록')", { timeoutMs: 90_000, intervalMs: 1500 });
  } catch (error) {
    const state = await cdp.evaluate(`({ title: document.title, url: String(location.href).slice(0, 90), text: (document.body.innerText || "").replace(/\\n{2,}/g, "\\n").slice(0, 600), elements: document.querySelectorAll("*").length, tabLabels: [...document.querySelectorAll(".lm-TabBar-tabLabel")].map((e) => (e.innerText || "").trim()).slice(0, 10) })`);
    process.stdout.write(`[대기 실패 진단] ${JSON.stringify(state, null, 1)}\n`);
    process.stdout.write(`[프론트 이벤트 ${events.length}건]\n${events.slice(-20).join("\n")}\n`);
    throw error;
  }
  await cdp.waitFor("document.body.innerText.includes('프로젝트 등록')", { timeoutMs: 60_000, intervalMs: 1000 });

  const phase1 = await cdp.evaluate(`(() => {
    const describe = (element) => ({ tag: element.tagName.toLowerCase(), text: (element.innerText || "").trim().replace(/\\n+/g, " | ").slice(0, 50), cls: String(element.className || "").slice(0, 55), id: element.id || "", ph: element.getAttribute("placeholder") || "" });
    return {
      inputs: [...document.querySelectorAll("input,textarea")].map(describe),
      buttons: [...document.querySelectorAll("button,[role=button]")].map(describe).slice(0, 25),
      treeNodes: [...document.querySelectorAll("[class*=TreeNode],[class*=tree-row],.theia-TreeNodeContent")].slice(0, 20).map(describe),
      widgetTitles: [...document.querySelectorAll(".lm-TabBar-tabLabel,.theia-Widget")].slice(0, 12).map((e) => (e.innerText || "").trim().slice(0, 30)),
      rightPanel: [...document.querySelectorAll("div,span")].filter((e) => /프로젝트 · 세션/.test((e.innerText || "").trim()) && (e.innerText || "").length < 400).slice(0, 3).map((e) => (e.innerText || "").trim().replace(/\\n+/g, " | ").slice(0, 300))
    };
  })()`);
  process.stdout.write(`[phase1]\n${JSON.stringify(phase1, null, 1).slice(0, 3000)}\n`);
} finally {
  await active.close();
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
