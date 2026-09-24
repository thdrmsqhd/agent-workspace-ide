import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Action } from "@awi/core";

const run=promisify(execFile);
export interface WorkflowCommand {
  readonly executable:string;
  readonly args:readonly string[];
  readonly timeoutMs?:number;
}
export interface WorkflowDefinition {
  readonly instructions?:string;
  readonly prepare:readonly WorkflowCommand[];
  readonly checks:readonly WorkflowCommand[];
  readonly integrationActions:ReadonlySet<Extract<Action,"merge"|"push"|"createPR">>;
}
function isRecord(value:unknown):value is Record<string,unknown>{
  return typeof value==="object"&&value!==null&&!Array.isArray(value);
}
function parseCommands(value:unknown):WorkflowCommand[]{
  if(value===undefined)return[];
  if(!Array.isArray(value))throw new Error("workflow 명령 목록이 배열이 아닙니다.");
  return value.map(item=>{
    if(!isRecord(item)||typeof item.executable!=="string"||!Array.isArray(item.args)||!item.args.every(v=>typeof v==="string")) {
      throw new Error("workflow 명령은 executable+args 배열이어야 합니다.");
    }
    if(item.executable.startsWith("-")||item.executable.includes("\n"))throw new Error("workflow 실행 파일이 올바르지 않습니다.");
    const timeoutMs=item.timeoutMs===undefined?undefined:Number(item.timeoutMs);
    if(timeoutMs!==undefined&&(!Number.isFinite(timeoutMs)||timeoutMs<=0))throw new Error("workflow timeout이 올바르지 않습니다.");
    return {executable:item.executable,args:[...item.args],...(timeoutMs===undefined?{}:{timeoutMs})};
  });
}
export async function discoverWorkflow(root:string):Promise<WorkflowDefinition>{
  const instructions=await readFile(join(root,"AGENTS.md"),"utf8").catch(()=>undefined);
  const raw=await readFile(join(root,".awi","workflow.json"),"utf8").catch(()=>undefined);
  if(!raw)return { ...(instructions?{instructions}:{}), prepare:[],checks:[],integrationActions:new Set() };
  const value:unknown=JSON.parse(raw);
  if(!isRecord(value))throw new Error("workflow.json 형식이 올바르지 않습니다.");
  const allowed=new Set(["merge","push","createPR"]);
  const actions=value.integrationActions===undefined?[]:value.integrationActions;
  if(!Array.isArray(actions)||!actions.every(v=>typeof v==="string"&&allowed.has(v)))throw new Error("integrationActions가 올바르지 않습니다.");
  return {
    ...(instructions?{instructions}:{}),
    prepare:parseCommands(value.prepare),
    checks:parseCommands(value.checks),
    integrationActions:new Set(actions as Array<"merge"|"push"|"createPR">),
  };
}
export interface CommandResult { readonly executable:string; readonly args:readonly string[]; readonly status:"passed"|"failed"; readonly exitCode:number; readonly stdout:string; readonly stderr:string }
export async function executeWorkflowCommands(root:string,commands:readonly WorkflowCommand[]):Promise<CommandResult[]>{
  const results:CommandResult[]=[];
  for(const command of commands){
    try{
      const {stdout,stderr}=await run(command.executable,[...command.args],{cwd:root,encoding:"utf8",timeout:command.timeoutMs??120_000,maxBuffer:16*1024*1024,windowsHide:true});
      results.push({executable:command.executable,args:[...command.args],status:"passed",exitCode:0,stdout,stderr});
    }catch(error){
      const e=error as Error&{code?:number|string;stdout?:string;stderr?:string};
      results.push({executable:command.executable,args:[...command.args],status:"failed",exitCode:typeof e.code==="number"?e.code:1,stdout:e.stdout??"",stderr:e.stderr??e.message});
      break;
    }
  }
  return results;
}
export function workflowActions(definition:WorkflowDefinition):ReadonlySet<Action>{
  return new Set<Action>(["read","search","edit","runLocal",...definition.integrationActions]);
}
