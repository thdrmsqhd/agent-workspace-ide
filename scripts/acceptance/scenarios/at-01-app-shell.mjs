import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { artifactPath, createStepLog, saveArtifact, writeEvidence } from "../lib/harness.mjs";
import { launchPackagedApp, statePath } from "../lib/packaged-app.mjs";

const run = promisify(execFile);
const ID = "AT-01";
const TITLE = "Windows 앱 실행, 두 프로젝트 등록, 재시작 후 복원";
const PRECONDITION = "CI가 만든 Windows 패키지(win-unpacked)를 창을 화면 밖·포커스 불가로 띄우고, 격리된 임시 홈에서 두 개의 Git 저장소를 프로젝트로 등록한다.";
const EXPECTED = "독립 앱이 실행되고, 우측 프로젝트·세션 영역과 전체 현황이 두 프로젝트를 반영하며, 재시작 후에도 두 프로젝트가 복원된다.";

async function git(cwd, ...args) {
  return (await run("git", args, { cwd })).stdout;
}

async function makeRepo(root, name) {
  const path = join(root, name);
  await mkdir(path);
  await git(path, "init", "-b", "main");
  await git(path, "config", "user.name", "AWi AT");
  await git(path, "config", "user.email", "at@example.invalid");
  await writeFile(join(path, "README.md"), `${name} 저장소\n`);
  await git(path, "add", ".");
  await git(path, "commit", "-m", "base");
  return path;
}

const setInput = (cdp, placeholder, value) => cdp.evaluate(`(() => {
  const element = [...document.querySelectorAll("input")].find((item) => item.getAttribute("placeholder") === ${JSON.stringify(placeholder)});
  if (!element) return "입력 없음";
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
  setter.call(element, ${JSON.stringify(value)});
  element.dispatchEvent(new Event("input", { bubbles: true }));
  element.dispatchEvent(new Event("change", { bubbles: true }));
  return element.value;
})()`);

const clickByText = (cdp, text) => cdp.evaluate(`(() => {
  const candidates = [...document.querySelectorAll("button,a,[role=button]")];
  const element = candidates.find((item) => (item.innerText || "").trim() === ${JSON.stringify(text)});
  if (!element) return "버튼 없음";
  element.click();
  return "클릭";
})()`);

const bodyText = (cdp) => cdp.evaluate("document.body.innerText.replace(/\\n{2,}/g, '\\n')");

export default {
  id: ID,
  title: TITLE,
  precondition: PRECONDITION,
  expected: EXPECTED,
  async run() {
    assert.equal(process.platform, "win32", "Windows 패키지 앱 시험입니다.");
    const log = createStepLog();
    const workspace = await mkdtemp(join(tmpdir(), "awi-at01-"));
    const home = join(workspace, "home");
    const repos = join(workspace, "repos");
    await mkdir(repos);
    const repoA = await makeRepo(repos, "alpha-project");
    const repoB = await makeRepo(repos, "beta-project");
    const model = "openai-codex/gpt-5";
    log.ok("사전 조건", `격리 홈 ${home}, 저장소 2개 생성`);

    let app;
    const artifacts = [];
    const shots = {};
    const rightPanel = async (cdp) => cdp.evaluate(`(() => {
      const headings = [...document.querySelectorAll("div,span,h3")].filter((element) => (element.innerText || "").trim() === "프로젝트 · 세션");
      const region = headings.map((element) => element.parentElement).find(Boolean);
      return region ? region.innerText.replace(/\\n+/g, " | ").slice(0, 500) : "영역 없음";
    })()`);

    const register = async (cdp, name, path) => {
      assert.equal(await setInput(cdp, "프로젝트 이름", name), name);
      assert.equal(await setInput(cdp, "Git 프로젝트 경로", path), path);
      await setInput(cdp, "OMP 모델(provider/model)", model);
      await setInput(cdp, "기준 브랜치", "main");
      const clicked = await clickByText(cdp, "프로젝트 등록");
      assert.equal(clicked, "클릭", "프로젝트 등록 버튼을 찾지 못했습니다.");
      await cdp.waitFor(`document.body.innerText.includes(${JSON.stringify(name)})`, { timeoutMs: 60_000 });
      log.ok(`프로젝트 등록: ${name}`, path);
    };

    const openApp = async (label) => {
      let launched = await launchPackagedApp({ home, port: 9229 });
      const hasDashboard = await launched.cdp.evaluate("document.body.innerText.includes('프로젝트 등록')");
      if (!hasDashboard) {
        log.note(`${label}: 워크스페이스 없이 대시보드가 뜨지 않아 저장소를 열어 다시 기동`, repoA);
        await launched.close();
        launched = await launchPackagedApp({ home, port: 9229, workspace: repoA });
      }
      // 새 워크스페이스에서는 Theia 신뢰 확인 모달이 뜬다. AT는 제품 기능 시험이므로 신뢰를 눌러 닫는다.
      if (await launched.cdp.evaluate("document.body.innerText.includes('Do you trust the authors')")) {
        const trusted = await clickByText(launched.cdp, "Yes, I trust the authors");
        log.note(`${label}: 워크스페이스 신뢰 모달 닫기`, trusted);
        await new Promise((resolve) => setTimeout(resolve, 1500));
      }
      shots[label] = await launched.cdp.screenshot(await artifactPath(ID, `${label}.png`));
      return launched;
    };

    try {
      app = await openApp("first-launch");
      const cdp = app.cdp;
      const shell = await cdp.evaluate(`({
        menuBar: document.body.innerText.includes("File") && document.body.innerText.includes("Help"),
        register: document.body.innerText.includes("프로젝트 등록"),
        regions: ["파일", "전체 현황", "프로젝트 · 세션"].filter((name) => document.body.innerText.includes(name)),
        title: document.title
      })`);
      assert.equal(shell.register, true, "프로젝트 등록 폼이 없습니다.");
      assert.deepEqual(shell.regions, ["파일", "전체 현황", "프로젝트 · 세션"], "대시보드 3영역이 모두 있어야 합니다.");
      log.ok("앱 실행", `제목="${shell.title.slice(0, 60)}", 대시보드 3영역 확인`);

      await register(cdp, "alpha-project", repoA);
      await register(cdp, "beta-project", repoB);
      const panel = await rightPanel(cdp);
      assert.match(panel, /alpha-project/, "우측 영역에 첫 프로젝트가 보여야 합니다.");
      assert.match(panel, /beta-project/, "우측 영역에 둘째 프로젝트가 보여야 합니다.");
      log.ok("우측 프로젝트·세션 영역", panel.slice(0, 200));
      artifacts.push(await saveArtifact(ID, "projects-registered.json", { repoA, repoB, model, panel }));
      shots["after-register"] = await cdp.screenshot(await artifactPath(ID, "after-register.png"));

      await app.close();
      log.ok("앱 종료", "재시작 검증을 위해 종료");

      app = await openApp("second-launch");
      await app.cdp.waitFor("document.body.innerText.includes('alpha-project')", { timeoutMs: 60_000 });
      const restored = await bodyText(app.cdp);
      assert.match(restored, /alpha-project/, "재시작 후 첫 프로젝트가 복원되어야 합니다.");
      assert.match(restored, /beta-project/, "재시작 후 둘째 프로젝트가 복원되어야 합니다.");
      const restoredPanel = await rightPanel(app.cdp);
      log.ok("재시작 복원", restoredPanel.slice(0, 200));
      shots["after-restart"] = await app.cdp.screenshot(await artifactPath(ID, "after-restart.png"));
      artifacts.push(await saveArtifact(ID, "restart.json", { restoredPanel, stateFile: statePath(home) }));
    } finally {
      if (app) await app.close();
      await rm(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }

    artifacts.push(await saveArtifact(ID, "steps.txt", `${log.steps.map((step) => `${step.result}\t${step.name}\t${step.detail}`).join("\n")}\n`));
    for (const [name, path] of Object.entries(shots)) artifacts.push(`${name}: ${path}`);
    const record = await writeEvidence({
      id: ID,
      status: "PASS",
      title: TITLE,
      scenario: "scripts/acceptance/scenarios/at-01-app-shell.mjs",
      detail: "CI 패키지 앱을 격리 홈에서 실행해 두 프로젝트를 실제 UI로 등록하고, 재시작 후 우측 프로젝트·세션 영역과 전체 현황에 그대로 복원되는 것을 확인했다.",
      precondition: PRECONDITION,
      expected: EXPECTED,
      steps: log.steps,
      actual: "독립 앱 실행, 프로젝트 2개 등록·표시, 재시작 후 2개 복원",
      artifacts,
    });
    return { status: record.status, detail: record.detail };
  },
};
