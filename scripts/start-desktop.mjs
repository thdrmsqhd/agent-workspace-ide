import { spawn } from "node:child_process";
import process from "node:process";

if (process.platform !== "win32") throw new Error("제품 데스크톱 셸은 Windows 대상입니다.");
const child=spawn("npm.cmd",["--prefix","apps/desktop","run","start"],{
  stdio:"inherit",windowsHide:false,shell:false
});
child.once("error",(error)=>{throw error;});
child.once("exit",(code)=>{process.exitCode=code??1;});
