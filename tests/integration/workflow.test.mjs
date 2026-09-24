import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { discoverWorkflow, executeWorkflowCommands, workflowActions } from "@awi/workflow";

test("프로젝트 지침이 없으면 테스트/push를 임의 강제하지 않는다",async(t)=>{
  const root=await mkdtemp(join(tmpdir(),"awi-workflow-"));t.after(()=>rm(root,{recursive:true,force:true}));
  const workflow=await discoverWorkflow(root);
  assert.deepEqual(workflow.prepare,[]);
  assert.deepEqual(workflow.checks,[]);
  assert.equal(workflow.integrationActions.size,0);
});
test("구조화된 workflow만 인자 배열로 실행하고 실패 뒤 명령은 중단한다",async(t)=>{
  const root=await mkdtemp(join(tmpdir(),"awi-workflow-"));t.after(()=>rm(root,{recursive:true,force:true}));
  await mkdir(join(root,".awi"));
  await writeFile(join(root,"AGENTS.md"),"# instructions");
  await writeFile(join(root,".awi","workflow.json"),JSON.stringify({
    prepare:[{executable:process.execPath,args:["-e","console.log('prepare')"]}],
    checks:[{executable:process.execPath,args:["-e","process.exit(2)"]},{executable:process.execPath,args:["-e","process.exit(0)"]}],
    integrationActions:["createPR"]
  }));
  const workflow=await discoverWorkflow(root);
  assert.equal(workflow.instructions,"# instructions");
  assert.ok(workflowActions(workflow).has("createPR"));
  const result=await executeWorkflowCommands(root,workflow.checks);
  assert.equal(result.length,1);
  assert.equal(result[0].status,"failed");
});
