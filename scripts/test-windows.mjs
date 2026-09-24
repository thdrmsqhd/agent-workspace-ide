import { spawn } from "node:child_process";
import process from "node:process";
if(process.platform!=="win32")throw new Error("Windows 전용 검증입니다.");
const files=[
  "tests/integration/processes.test.mjs",
  "tests/integration/ports.test.mjs",
  "tests/integration/runtime.test.mjs",
  "tests/integration/app-host.test.mjs"
];
await new Promise((resolve,reject)=>{
  const child=spawn(process.execPath,["--test",...files],{stdio:"inherit",windowsHide:true,shell:false});
  child.once("error",reject);
  child.once("exit",(code)=>code===0?resolve():reject(new Error(`Windows 통합 검증 실패: ${code}`)));
});
