import { test } from "node:test";
import assert from "node:assert/strict";
import process from "node:process";
import { runPreparationPlan, retryPreparationStep } from "@awi/environment";

test("환경 준비는 실패 단계에서 멈추고 사용자가 같은 단계만 재시도할 수 있다",async()=>{
  const ok={id:"ok",executable:process.execPath,args:["-e","process.exit(0)"],cwd:process.cwd()};
  const bad={id:"bad",executable:process.execPath,args:["-e","process.exit(7)"],cwd:process.cwd()};
  const skipped={id:"skipped",executable:process.execPath,args:["-e","process.exit(0)"],cwd:process.cwd()};
  const result=await runPreparationPlan([ok,bad,skipped]);
  assert.equal(result.completed,false);
  assert.deepEqual(result.results.map(x=>x.stepId),["ok","bad"]);
  assert.equal((await retryPreparationStep(ok)).status,"passed");
});
