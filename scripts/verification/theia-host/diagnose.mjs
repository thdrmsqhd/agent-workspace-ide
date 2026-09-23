// 진단용: 사이드 패널을 펼치고 탐색기 트리를 노출하는 조작을 확인한다.
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { CdpPage } from "./cdp.mjs";

const port = Number(process.env.AWI_THEIA_PORT ?? 3000);
const debugPort = Number(process.env.AWI_CDP_PORT ?? 9334);
const workspaceRoot = process.env.AWI_WORKSPACE ?? process.argv[2];

const profileDir = join(tmpdir(), `awi-cdp-diag2-${Date.now()}`);
mkdirSync(profileDir, { recursive: true });
const workspaceUrl = workspaceRoot ? `http://127.0.0.1:${port}/#/${workspaceRoot.replace(/\\/gu, "/")}` : `http://127.0.0.1:${port}/`;
const chrome = spawn(
  process.env.AWI_CHROME ?? "C:/Program Files/Google/Chrome/Application/chrome.exe",
  ["--headless=new", "--disable-gpu", "--no-first-run", "--window-size=1400,900", `--user-data-dir=${profileDir}`, `--remote-debugging-port=${debugPort}`, workspaceUrl],
  { windowsHide: true, stdio: "ignore" },
);
chrome.unref();

const { page } = await CdpPage.attach({ port: debugPort, urlFilter: "127.0.0.1" });
await page.send("Page.enable");
await page.waitFor("document.readyState === 'complete'", { timeoutMs: 60000, description: "문서 로드" });
await page.waitFor("(() => !!document.querySelector('#theia-main-content-panel, .theia-app-shell'))()", { timeoutMs: 120000, description: "앱 셸" });
await delay(9000);

const before = await page.evaluate(`(() => {
  const panel = document.querySelector('.theia-side-panel');
  return { panelWidth: panel ? panel.getBoundingClientRect().width : -1, bodyHasProject: /java-project/u.test(document.body.innerText || '') };
})()`);
process.stdout.write(`펼치기 전: ${JSON.stringify(before)}\n`);

const clickResult = await page.evaluate(`(() => {
  const left = document.querySelector('#theia-left-content-panel, .theia-app-sidebar, #theia-left-side-panel');
  return { leftExists: !!left, leftClass: left ? (left.className || '').toString().slice(0, 120) : null, leftWidth: left ? left.getBoundingClientRect().width : -1 };
})()`);
process.stdout.write(`좌측 패널: ${JSON.stringify(clickResult)}\n`);

/** CDP 키 입력: 사용자 포커스가 아니라 이 브라우저 페이지에만 전달된다. */
async function pressKey(key, code, modifiers = 0) {
  await page.send("Input.dispatchKeyEvent", { type: "keyDown", key, code, windowsVirtualKeyCode: code === "KeyB" ? 66 : 69, modifiers });
  await page.send("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode: code === "KeyB" ? 66 : 69, modifiers });
}

await pressKey("b", "KeyB", 2); // Ctrl+B: 사이드 패널 토글
await delay(3000);
const afterCtrlB = await page.evaluate("(() => { const p = document.querySelector('.theia-side-panel'); return p ? p.getBoundingClientRect().width : -1; })()");
process.stdout.write(`Ctrl+B 후 폭: ${afterCtrlB}\n`);

await pressKey("E", "KeyE", 2 | 8); // Ctrl+Shift+E: 탐색기 포커스
await delay(4000);

const after = await page.evaluate(`(() => {
  const panel = document.querySelector('.theia-side-panel');
  const text = (document.body.innerText || '');
  const treeNodes = Array.from(document.querySelectorAll('.theia-TreeNode, .theia-tree-node, [role="treeitem"]')).map((el) => (el.textContent || '').trim().slice(0, 40));
  return {
    panelWidth: panel ? panel.getBoundingClientRect().width : -1,
    bodyHasProject: /java-project/u.test(text),
    treeNodeCount: treeNodes.length,
    treeNodes: treeNodes.slice(0, 12),
  };
})()`);
process.stdout.write(`펼친 후: ${JSON.stringify(after, null, 2)}\n`);
const shot = join(tmpdir(), "awi-diag2.png");
await page.screenshot(shot);
process.stdout.write(`스크린샷: ${shot}\n`);
page.close();
chrome.kill();
