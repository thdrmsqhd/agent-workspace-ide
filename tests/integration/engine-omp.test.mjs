import { test } from "node:test";
import assert from "node:assert/strict";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";
import { OmpEngineAdapter, discussionOverlay } from "@awi/engine-omp";
import { ProcessTreeSupervisor } from "@awi/processes";

const fixture = fileURLToPath(new URL("../fixtures/fake-omp-engine.mjs", import.meta.url));

test("논의 오버레이는 읽기 도구만 열고 프로젝트 MCP를 닫는다", () => {
  const overlay = discussionOverlay();
  assert.deepEqual(overlay.tools, ["read","glob","grep","todo"]);
  assert.equal(overlay.projectMcpEnabled, false);
  assert.ok(overlay.denied.includes("bash"));
  assert.ok(overlay.denied.includes("write"));
});

test("OMP abort가 멈추면 fallback 없이 종료 판정한다", async (t) => {
  const supervisor = new ProcessTreeSupervisor();
  const adapter = new OmpEngineAdapter(supervisor);
  t.after(() => adapter.shutdown("T"));
  await adapter.start({ taskId: "T", executable: process.execPath, args: [fixture], cwd: process.cwd() });
  const result = await adapter.abortTask("T", 500);
  assert.deepEqual(result, { graceful: true, fallbackUsed: false });
});

test("OMP abort가 자손 중단을 보장하지 못하면 엔진 그룹만 강제 종료하고 서버 역할은 유지한다", async (t) => {
  const supervisor = new ProcessTreeSupervisor();
  const adapter = new OmpEngineAdapter(supervisor);
  const server = supervisor.start({ ownerId: "T", role: "server", executable: process.execPath, args: ["-e", "setInterval(()=>{},1000)"] });
  t.after(() => supervisor.stopAll({ graceMs: 200, forceWaitMs: 3000 }));
  await adapter.start({ taskId: "T", executable: process.execPath, args: [fixture, "--ignore-abort"], cwd: process.cwd() });
  const result = await adapter.abortTask("T", 200);
  assert.equal(result.fallbackUsed, true);
  const snapshots = supervisor.list("T");
  assert.equal(snapshots.find((item) => item.role === "engine").state, "exited");
  assert.equal(snapshots.find((item) => item.pid === server.pid).state, "running");
});

test("하위 에이전트 구독과 extension UI 응답은 RPC 명령/프레임 경계를 사용한다", async (t) => {
  const supervisor=new ProcessTreeSupervisor();
  const adapter=new OmpEngineAdapter(supervisor);
  t.after(()=>adapter.shutdown("T"));
  await adapter.start({taskId:"T",executable:process.execPath,args:[fixture],cwd:process.cwd()});
  await adapter.setSubagentSubscription("progress");
  const list=await adapter.getSubagents();
  assert.equal(list.success,true);
  adapter.respondExtensionUi("ui-1",{value:"answer"});
});


test("prompt와 steer는 OMP 공식 images 필드를 사용하고 임의 attachments 필드를 보내지 않는다", async (t) => {
  const supervisor = new ProcessTreeSupervisor();
  const adapter = new OmpEngineAdapter(supervisor);
  t.after(() => adapter.shutdown("T"));
  await adapter.start({ taskId: "T", executable: process.execPath, args: [fixture], cwd: process.cwd() });
  const image = { type: "image", data: "AQID", mimeType: "image/png" };

  const prompted = await adapter.prompt("이미지 확인", [image]);
  assert.deepEqual(prompted.data.received.images, [image]);
  assert.equal("attachments" in prompted.data.received, false);

  const steered = await adapter.steer("추가 확인", [image]);
  assert.deepEqual(steered.data.received.images, [image]);
  assert.equal("attachments" in steered.data.received, false);
});
