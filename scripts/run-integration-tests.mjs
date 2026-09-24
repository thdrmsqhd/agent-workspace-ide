import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import { fileURLToPath, URL } from "node:url";
import process from "node:process";

const root=fileURLToPath(new URL("../",import.meta.url));
const directory=fileURLToPath(new URL("../tests/integration/",import.meta.url));
const files=(await readdir(directory))
  .filter((name)=>name.endsWith(".test.mjs"))
  .sort();

async function killTree(child){
  if(!child.pid)return;
  if(process.platform==="win32"){
    await new Promise((resolve)=>{
      const killer=spawn("taskkill",["/PID",String(child.pid),"/T","/F"],{stdio:"ignore",windowsHide:true});
      killer.once("error",()=>resolve());
      killer.once("exit",()=>resolve());
    });
    return;
  }
  try{process.kill(-child.pid,"SIGKILL");}catch{}
}

for(const file of files){
  process.stdout.write(`\n[integration] ${file}\n`);
  await new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,["--test",`tests/integration/${file}`],{
      cwd:root,
      stdio:"inherit",
      windowsHide:true,
      detached:process.platform!=="win32",
    });
    let settled=false;
    const timer=setTimeout(async()=>{
      if(settled)return;
      settled=true;
      await killTree(child);
      reject(new Error(`통합 테스트가 60초 안에 종료되지 않았습니다: ${file}`));
    },60_000);
    child.once("error",(error)=>{
      if(settled)return;
      settled=true;clearTimeout(timer);reject(error);
    });
    child.once("exit",(code,signal)=>{
      if(settled)return;
      settled=true;clearTimeout(timer);
      if(code===0)resolve();
      else reject(new Error(`통합 테스트 실패: ${file} (code=${code}, signal=${signal??"none"})`));
    });
  });
}
