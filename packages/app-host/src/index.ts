import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { StateStore } from "@awi/persistence";
import type { WorkspaceRuntime } from "@awi/runtime";
import type { AgentItem, InputRequestUiItem, TaskItem, WorkspaceData } from "@awi/ui";

const exec = promisify(execFile);

async function changedFileCount(worktreePath: string | undefined): Promise<number> {
  if (!worktreePath) return 0;
  try {
    const { stdout } = await exec("git", ["status","--porcelain=v1"], { cwd:worktreePath,encoding:"utf8",windowsHide:true,timeout:10_000 });
    return stdout.split(/\r?\n/u).filter(Boolean).length;
  } catch {
    return 0;
  }
}

function normalizeSubagents(taskId:string, data:unknown):AgentItem[] {
  const source = Array.isArray(data) ? data :
    (data && typeof data==="object" && Array.isArray((data as Record<string,unknown>).subagents)
      ? (data as Record<string,unknown>).subagents as unknown[] : []);
  return source.flatMap((value)=>{
    if(!value || typeof value!=="object") return [];
    const item=value as Record<string,unknown>;
    if(typeof item.id!=="string") return [];
    return [{
      id:item.id,taskId,
      ...(typeof item.parentAgentId==="string"?{parentAgentId:item.parentAgentId}:{}),
      status:typeof item.status==="string"?item.status:"unknown",
      ...(typeof item.description==="string"?{currentAction:item.description}:{}),
    }];
  });
}

export class ApplicationController {
  constructor(private readonly store:StateStore, private readonly runtime:WorkspaceRuntime){}

  async snapshot():Promise<WorkspaceData>{
    const projects=this.store.listProjects();
    const taskRows=this.store.listTasks();
    const tasks:TaskItem[]=[];
    const agents:AgentItem[]=[];
    for(const task of taskRows){
      const queue=this.store.getTaskQueue(task.id);
      const inputs=this.store.listPendingInputRequests(task.id);
      const inputRequests:InputRequestUiItem[]=inputs.map((input)=>{
        const title=typeof input.payload.title==="string"?input.payload.title:undefined;
        const message=typeof input.payload.message==="string"?input.payload.message:"응답이 필요합니다.";
        const options=Array.isArray(input.payload.options)?input.payload.options.filter((x):x is string=>typeof x==="string"):undefined;
        return {id:input.id,...(title?{title}:{}),message,...(options?.length?{options}:{})};
      });
      tasks.push({
        id:task.id,projectId:task.projectId,originalPrompt:task.originalPrompt,createdAt:task.createdAt,
        status:task.disposition!=="active"?task.disposition:task.runState,
        changedFileCount:await changedFileCount(task.worktreePath),
        pendingInputCount:inputRequests.length,
        archived:task.phase==="archived",
        queue:queue.messages.map((item)=>({id:item.id,text:item.text,revision:item.revision,state:item.state})),
        inputRequests,
      });
      try{agents.push(...normalizeSubagents(task.id,await this.runtime.subagents(task.id)));}
      catch{/* 정지/보관 작업은 엔진이 없어도 카드 복원 가능 */}
    }
    return {projects,tasks,agents};
  }

  createRequest(projectId:string,prompt:string):Promise<string>{return this.runtime.createDiscussion(projectId,prompt);}
  beginTask(taskId:string,baseRef?:string):Promise<void>{return this.runtime.startTask(taskId,baseRef);}
  sendTask(taskId:string,text:string,mode:"immediate"|"queued"):Promise<string|undefined>{return this.runtime.send(taskId,text,mode);}
  abortTask(taskId:string):Promise<void>{return this.runtime.abortTask(taskId);}
  resumeTask(taskId:string):Promise<void>{return this.runtime.resumeTask(taskId);}
  cancelTask(taskId:string):Promise<void>{return this.runtime.cancelTask(taskId);}
  archiveTask(taskId:string):void{this.runtime.archiveTask(taskId);}
  updateQueued(taskId:string,messageId:string,revision:number,text:string):void{this.runtime.updateQueued(taskId,messageId,revision,text);}
  deleteQueued(taskId:string,messageId:string,revision:number):void{this.runtime.deleteQueued(taskId,messageId,revision);}
  async respondInput(_taskId:string,inputRequestId:string,response:string|boolean):Promise<void>{
    await this.runtime.respondInput(inputRequestId,typeof response==="boolean"?{confirmed:response}:{value:response});
  }
  async addAttachment(taskId:string,kind:"file"|"folder"|"image",relativePath:string):Promise<string>{
    return (await this.runtime.attachPath(taskId,kind,relativePath)).id;
  }
  addCodeSelection(taskId:string,relativePath:string,startLine:number,endLine:number,content:string):string{
    return this.runtime.attachCodeSelection(taskId,relativePath,startLine,endLine,content).id;
  }
  syncTask(taskId:string):Promise<{inputRequestIds:string[];subagentEvents:number}>{return this.runtime.syncEngineEvents(taskId);}
}
