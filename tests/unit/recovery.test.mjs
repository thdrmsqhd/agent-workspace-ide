import { test } from "node:test";
import assert from "node:assert/strict";
import { canAutoRetry, gracefulShutdown, recoveryPlan, retrySchedule, sameProcessIdentity } from "@awi/recovery";

test("읽기만 자동 재시도하고 부작용은 결과 확인으로 보낸다",()=>{
  assert.equal(canAutoRetry("read"),true);
  assert.equal(canAutoRetry("side_effect"),false);
  assert.deepEqual(recoveryPlan({runState:"running",integrationState:"pushing",operationStates:["unknown"]}),["resume_wait","verify_side_effect","preserve"]);
  assert.deepEqual(retrySchedule(),[1000,2000,4000,8000,15000]);
});

test("종료는 UI 저장 성공 뒤에만 프로세스를 정리한다",async()=>{
  const order=[];
  await gracefulShutdown({
    async persistUiState(){order.push("persist");},
    async stopOwnedProcesses(){order.push("stop");},
    async markCleanShutdown(){order.push("clean");}
  });
  assert.deepEqual(order,["persist","stop","clean"]);
  await assert.rejects(gracefulShutdown({
    async persistUiState(){throw new Error("disk full");},
    async stopOwnedProcesses(){order.push("bad-stop");},
    async markCleanShutdown(){}
  }),/disk full/);
  assert.equal(order.includes("bad-stop"),false);
});

test("PID만 같고 시작 식별자가 다르면 고아 프로세스로 오인하지 않는다",()=>{
  assert.equal(sameProcessIdentity({pid:10,startToken:"A"},{pid:10,startToken:"B"}),false);
  assert.equal(sameProcessIdentity({pid:10,startToken:"A"},{pid:10,startToken:"A"}),true);
});
