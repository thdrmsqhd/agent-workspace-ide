import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { Buffer } from "node:buffer";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath, URL } from "node:url";
import { promisify } from "node:util";
import { OmpEngineAdapter } from "@awi/engine-omp";
import { StateStore } from "@awi/persistence";
import { ProcessTreeSupervisor } from "@awi/processes";
import { WorkspaceRuntime } from "@awi/runtime";
import { SettingsRegistry } from "@awi/settings";

const run = promisify(execFile);
const fake = fileURLToPath(new URL("../fixtures/fake-omp-engine.mjs", import.meta.url));

test("프로젝트 등록→논의→명시적 워크트리 시작→대기열 전달→중단/재개 흐름", async (t) => {
  const root = await mkdtemp(join(tmpdir(),"awi-runtime-"));
  t.after(() => rm(root,{recursive:true,force:true}));
  const repo = join(root,"repo"); await mkdir(repo);
  await run("git",["init","-b","main"],{cwd:repo});
  await run("git",["config","user.name","Test"],{cwd:repo});
  await run("git",["config","user.email","test@example.invalid"],{cwd:repo});
  await writeFile(join(repo,"README.md"),"base\n");
  await run("git",["add","."],{cwd:repo}); await run("git",["commit","-m","base"],{cwd:repo});

  const store = await StateStore.open(join(root,"state.sqlite"));
  const supervisor = new ProcessTreeSupervisor();
  const settings = new SettingsRegistry();
  const testFactory = {
    async create(taskId,cwd,_snapshot,_phase,sessionFile) {
      const adapter = new OmpEngineAdapter(supervisor);
      await adapter.start({taskId,executable:process.execPath,args:[fake],cwd});
      if(sessionFile) await adapter.switchSession(sessionFile);
      return adapter;
    }
  };
  const runtime = new WorkspaceRuntime({
    store,settings,supervisor,engineFactory:testFactory,
    worktreeRoot:join(root,"worktrees"),journalDirectory:join(root,"journals")
  });
  t.after(async()=>{await runtime.shutdown();store.close();});

  const projectId = await runtime.registerProject("P",repo,"main",{engine:"omp",model:"fake",mode:"manual"});
  const same = await runtime.registerProject("P2",repo,"main",{engine:"omp",model:"fake",mode:"manual"});
  assert.equal(same,projectId);

  const taskId = await runtime.createDiscussion(projectId,"기능을 검토해줘");
  assert.equal(store.getTaskInfo(taskId).phase,"discussion");
  await sleep(80);
  await runtime.startTask(taskId);
  assert.equal(store.getTaskInfo(taskId).phase,"execution");

  await sleep(80);
  store.setTaskRunState(taskId,"idle","enabled");
  const messageId = await runtime.send(taskId,"다음 작업","queued");
  assert.ok(messageId);
  assert.equal(await runtime.dispatchNextQueued(taskId),true);
  assert.equal(store.getTaskQueue(taskId).messages.find((m)=>m.id===messageId).state,"finished");

  store.setTaskRunState(taskId,"running","enabled");
  await runtime.abortTask(taskId);
  assert.equal(store.getTaskQueue(taskId).runState,"paused");
  await runtime.resumeTask(taskId);
  assert.equal(store.getTaskQueue(taskId).runState,"running");
});


test("저장된 첨부를 실제 OMP message/images 계약으로 변환한다", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "awi-runtime-attachments-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = join(root, "repo");
  await mkdir(repo);
  await mkdir(join(repo, "docs"));
  await writeFile(join(repo, "docs", "note.txt"), "attached text\n");
  await writeFile(join(repo, "diagram.png"), Buffer.from([9, 8, 7]));

  const store = await StateStore.open(join(root, "state.sqlite"));
  const supervisor = new ProcessTreeSupervisor();
  const settings = new SettingsRegistry();
  const prompts = [];
  const adapter = {
    async setSubagentSubscription() {},
    async prompt(message, images = []) { prompts.push({ type: "prompt", message, images }); return { data: { agentInvoked: false } }; },
    async steer(message, images = []) { prompts.push({ type: "steer", message, images }); return { data: {} }; },
    async state() { return { data: { isStreaming: false } }; },
    async sessionFile() { return "recording-session.jsonl"; },
    async shutdown() {},
  };
  const runtime = new WorkspaceRuntime({
    store, settings, supervisor, engineFactory: { async create() { return adapter; } },
    worktreeRoot: join(root, "worktrees"), journalDirectory: join(root, "journals"),
  });
  t.after(async () => { await runtime.shutdown(); store.close(); });

  const projectId = store.createProject("P", repo, "runtime-attachment-" + Date.now(), "main");
  settings.setProjectDefault(projectId, { engine: "omp", model: "fake", mode: "manual" });
  const taskId = await runtime.createDiscussion(projectId, "초기 요청");
  const folder = await runtime.attachPath(taskId, "folder", "docs");
  const image = await runtime.attachPath(taskId, "image", "diagram.png");
  const code = runtime.attachCodeSelection(taskId, "src/example.ts", 3, 4, "const selected = true;");

  await runtime.send(taskId, "첨부를 검토해줘", "immediate", [folder.id, image.id, code.id]);
  const sent = prompts.at(-1);
  assert.equal(sent.type, "prompt");
  assert.match(sent.message, /첨부를 검토해줘/);
  assert.match(sent.message, /path: docs\/note\.txt/);
  assert.match(sent.message, /attached text/);
  assert.match(sent.message, /path: src\/example\.ts/);
  assert.match(sent.message, /lines: 3-4/);
  assert.match(sent.message, /const selected = true/);
  assert.deepEqual(sent.images, [{
    type: "image",
    data: Buffer.from([9, 8, 7]).toString("base64"),
    mimeType: "image/png",
  }]);
});
