import { test } from "node:test";
import assert from "node:assert/strict";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";
import { OmpEngineAdapter } from "@awi/engine-omp";
import { ProcessTreeSupervisor } from "@awi/processes";

const fixture = fileURLToPath(new URL("../fixtures/fake-omp-engine.mjs", import.meta.url));

test("OMP 어댑터는 하위 에이전트·모델·메시지·세션 RPC를 명시적 API로 노출한다", async (t) => {
  const supervisor = new ProcessTreeSupervisor();
  const adapter = new OmpEngineAdapter(supervisor);
  t.after(() => adapter.shutdown("rpc"));
  await adapter.start({taskId:"rpc",executable:process.execPath,args:[fixture],cwd:process.cwd()});
  await adapter.setSubagentSubscription("progress");
  assert.ok(await adapter.getSubagents());
  assert.ok(await adapter.getSubagentMessages({subagentId:"sub"}));
  assert.ok(await adapter.getMessagesPage(undefined,10));
  assert.ok(await adapter.getAvailableModels());
  await adapter.setModel("fake","m");
  adapter.respondExtensionUi("ui-1",{confirmed:true});
});
