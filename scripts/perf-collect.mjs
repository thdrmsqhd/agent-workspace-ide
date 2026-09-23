import { execFile } from "node:child_process";
import { mkdir, writeFile, appendFile } from "node:fs/promises";
import { hostname, platform, release } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import { promisify } from "node:util";

const exec=promisify(execFile);
const args=new Map(process.argv.slice(2).map(item=>{const [k,...v]=item.replace(/^--/u,"").split("=");return [k,v.join("=")];}));
const output=resolve(args.get("output")??"perf-output");
const configuration=args.get("configuration")??"candidate";
const workload=Number(args.get("workload")??"3");
const duration=Number(args.get("duration")??"30");
const pidArgs=process.argv.slice(2).filter(item=>item.startsWith("--pid=")).map(item=>item.slice(6));
if(!["baseline","candidate"].includes(configuration)||![3,12].includes(workload)||!Number.isFinite(duration)||duration<=0||pidArgs.length===0){
  throw new Error("사용법: npm run perf:collect -- --output=dir --configuration=baseline|candidate --workload=3|12 --duration=30 --pid=role:1234");
}
await mkdir(output,{recursive:true});
await writeFile(join(output,"environment.json"),JSON.stringify({configuration,workload,hostname:hostname(),platform:platform(),release:release(),node:process.version,startedAt:new Date().toISOString()},null,2)+"\n");
await writeFile(join(output,"process-samples.csv"),"runId,configuration,timestamp,pid,startIdentity,role,privateBytes,privateWorkingSet,cpuPercent\n");
await writeFile(join(output,"interaction-latency.csv"),"runId,interaction,timestamp,durationMs\n");
const runId=`${Date.now()}-${configuration}-${workload}`;

async function sample(pid){
  if(process.platform==="win32"){
    const script=`$p=Get-Process -Id ${pid} -ErrorAction Stop; Write-Output ($p.Id.ToString()+','+$p.StartTime.ToFileTimeUtc().ToString()+','+$p.PrivateMemorySize64.ToString()+','+$p.WorkingSet64.ToString()+','+$p.CPU.ToString())`;
    const {stdout}=await exec("powershell",["-NoProfile","-Command",script],{windowsHide:true});
    const [id,start,privateBytes,working,cpu]=stdout.trim().split(",");
    return {pid:Number(id),startIdentity:start,privateBytes:Number(privateBytes),working:Number(working),cpu:Number(cpu)||0};
  }
  const stat=await import("node:fs/promises").then(fs=>fs.readFile(`/proc/${pid}/stat`,"utf8"));
  const status=await import("node:fs/promises").then(fs=>fs.readFile(`/proc/${pid}/status`,"utf8"));
  const startIdentity=stat.trim().split(" ")[21]??"unknown";
  const rssKb=Number(status.match(/^VmRSS:\s+(\d+)/mu)?.[1]??0);
  const privateKb=Number(status.match(/^RssAnon:\s+(\d+)/mu)?.[1]??rssKb);
  return {pid,startIdentity,privateBytes:privateKb*1024,working:rssKb*1024,cpu:0};
}
for(let second=0;second<duration;second++){
  const timestamp=Date.now();
  for(const spec of pidArgs){
    const split=spec.lastIndexOf(":"); const role=spec.slice(0,split); const pid=Number(spec.slice(split+1));
    const s=await sample(pid);
    await appendFile(join(output,"process-samples.csv"),`${runId},${configuration},${timestamp},${s.pid},${s.startIdentity},${role},${s.privateBytes},${s.working},${s.cpu}\n`);
  }
  await new Promise(resolve=>setTimeout(resolve,1000));
}
await writeFile(join(output,"workload.md"),`# Workload\n\nconfiguration: ${configuration}\nworkload: ${workload}\ndurationSeconds: ${duration}\n`);
await writeFile(join(output,"result.md"),"# Result\n\n원시 측정 완료. baseline/candidate 비교는 @awi/performance에서 계산한다.\n");
