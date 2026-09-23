import { readFile } from "node:fs/promises";
const data=JSON.parse(await readFile("docs/evidence/reuse-evaluation.json","utf8"));
let measuredWeight=0,earned=0,total=0;
for(const item of data.criteria){
  total+=item.weight;
  if(item.status==="pass"||item.status==="fail"){
    measuredWeight+=item.weight;
    if(item.status==="pass") earned+=item.weight;
  }
}
const verifiedPercent=total===0?0:earned/total*100;
const coveragePercent=total===0?0:measuredWeight/total*100;
const decision=coveragePercent===100?(verifiedPercent>=80?"reuse-candidate":"do-not-fork"):"undetermined";
process.stdout.write(JSON.stringify({verifiedPercent,coveragePercent,decision},null,2)+"\n");
