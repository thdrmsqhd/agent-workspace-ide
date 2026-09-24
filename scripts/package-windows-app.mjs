import { spawn } from "node:child_process";
import { URL } from "node:url";
import process from "node:process";

if(process.platform!=="win32")throw new Error("Windows 패키징은 Windows runner에서 실행해야 합니다.");
const cwd=new URL("../apps/desktop/",import.meta.url);
async function run(command,args){
  await new Promise((resolve,reject)=>{
    const child=spawn(command,args,{cwd,stdio:"inherit",windowsHide:true,shell:false});
    child.once("error",reject);
    child.once("exit",(code)=>code===0?resolve():reject(new Error(`${command} 실패: ${code}`)));
  });
}
await run("npm.cmd",["install","--ignore-scripts"]);
await run("npm.cmd",["run","download:plugins"]);
await run("npm.cmd",["run","rebuild"]);
await run("npm.cmd",["run","build"]);
await run("npm.cmd",["run","package"]);
