import { test } from "node:test";
import assert from "node:assert/strict";
import { createIntegratedPullRequest, normalizeWorkflowInstructions } from "@awi/integration";

test("워크플로우가 없는 프로젝트에 테스트/push/PR을 임의 추가하지 않는다",()=>{
 assert.deepEqual(normalizeWorkflowInstructions(undefined),{preparationStepIds:[],requiredChecks:[],integrationActions:[]});
 const plan=normalizeWorkflowInstructions({preparationStepIds:["install","install"],requiredChecks:["unit"],integrationActions:["merge"]});
 assert.deepEqual(plan.preparationStepIds,["install"]);
 assert.deepEqual(plan.integrationActions,["merge"]);
});

test("PR 생성은 정책 승인과 공급자 경계를 거친다",async()=>{
 const policy={mode:"automatic",policyHash:"p",allowedActions:new Set(["createPR"])};
 const result=await createIntegratedPullRequest(
   {repoKey:"r",headRef:"feature",baseRef:"main",title:"T",body:"B"},
   policy,undefined,{async create(){return {url:"https://example.test/pr/1",id:"1"};}}
 );
 assert.equal(result.state,"pr_created");
 await assert.rejects(createIntegratedPullRequest(
   {repoKey:"r",headRef:"feature",baseRef:"main",title:"T",body:"B"},
   {mode:"manual",policyHash:"p",allowedActions:new Set(["createPR"])},undefined,{async create(){return {url:"https://example.test/pr/1",id:"1"};}}
 ),/PR 승인 필요/);
});
