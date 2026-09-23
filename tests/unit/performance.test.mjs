import { test } from "node:test";
import assert from "node:assert/strict";
import { compare, summarize } from "@awi/performance";

test("3개·12개 baseline/candidate가 모두 있어야 감소율을 계산한다",()=>{
  const rows=[];
  for(const size of [3,12]){
    for(const [configuration,bytes] of [["baseline",100],["candidate",70]]){
      rows.push({runId:`${configuration}-${size}`,configuration,workloadSize:size,timestamp:1,pid:1,startIdentity:"x",role:"app",privateBytes:bytes,privateWorkingSet:bytes,cpuPercent:0});
    }
  }
  const result=compare(summarize(rows));
  assert.equal(result.length,2);
  assert.equal(result[0].medianReductionPercent,30);
  assert.throws(()=>compare(summarize(rows.filter(r=>!(r.configuration==="candidate"&&r.workloadSize===12)))),/12개/);
});
