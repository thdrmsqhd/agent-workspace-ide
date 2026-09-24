import { execFile } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import type { StateStore } from "@awi/persistence";
import { compareText, type DiffModel } from "@awi/diff";
import { resolveWithin } from "@awi/worktrees";
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

  registerProject(name:string,repoPath:string,defaultBranch:string,model:string,mode:"manual"|"automatic"="manual"):Promise<string>{
    return this.runtime.registerProject(name,repoPath,defaultBranch,{engine:"omp",model,mode});
  }
  projectSettings(projectId:string):{revision:number;settings:Record<string,unknown>}|undefined{return this.store.getSettingsSnapshot("project",projectId);}
  updateProjectSettings(projectId:string,model:string,mode:"manual"|"automatic",expectedRevision:number):number{
    return this.runtime.updateProjectSettings(projectId,{engine:"omp",model,mode},expectedRevision);
  }
  changeModel(taskId:string,provider:string,modelId:string):Promise<void>{return this.runtime.changeModel(taskId,provider,modelId);}
  previewImport(sourcePath:string){return this.runtime.previewExistingChanges(sourcePath);}
  importExistingSession(input:{projectId:string;originalPrompt:string;sessionPath:string;baseRef?:string;sourcePath?:string;selectedChangeIds?:readonly string[]}):Promise<string>{
    return this.runtime.importExistingSession(input);
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
  async respondInput(taskId:string,inputRequestId:string,response:string|boolean):Promise<void>{
    if(!taskId.trim()) throw new Error("작업 ID가 필요합니다.");
    await this.runtime.respondInput(inputRequestId,typeof response==="boolean"?{confirmed:response}:{value:response});
  }
  attachments(taskId:string){return this.store.listAttachments(taskId);}
  async addAttachment(taskId:string,kind:"file"|"folder"|"image",relativePath:string):Promise<string>{
    return (await this.runtime.attachPath(taskId,kind,relativePath)).id;
  }
  removeAttachment(taskId:string,attachmentId:string):void{this.runtime.removeAttachment(taskId,attachmentId);}
  addCodeSelection(taskId:string,relativePath:string,startLine:number,endLine:number,content:string):string{
    return this.runtime.attachCodeSelection(taskId,relativePath,startLine,endLine,content).id;
  }
  addCodeSelectionUri(taskId:string,fileUri:string,startLine:number,endLine:number,content:string):string{
    const task=this.store.getTaskInfo(taskId);
    const project=this.store.getProjectInfo(task.projectId);
    const root=task.worktreePath ?? project.repoPath;
    const absolute=fileURLToPath(fileUri);
    const relativePath=relative(root,absolute);
    if(!relativePath || isAbsolute(relativePath) || relativePath===".." || relativePath.startsWith(".."+sep)){
      throw new Error("현재 편집기 파일이 선택 작업 경계를 벗어납니다.");
    }
    return this.runtime.attachCodeSelection(taskId,relativePath.split(sep).join("/"),startLine,endLine,content).id;
  }
  syncTask(taskId:string):Promise<{inputRequestIds:string[];subagentEvents:number}>{return this.runtime.syncEngineEvents(taskId);}

  taskContext(taskId:string):{taskId:string;rootPath:string;rootUri:string;phase:string;runState:string}{
    const task=this.store.getTaskInfo(taskId);
    const project=this.store.getProjectInfo(task.projectId);
    const rootPath=task.worktreePath ?? project.repoPath;
    return {taskId,rootPath,rootUri:pathToFileURL(rootPath).toString(),phase:task.phase,runState:task.runState};
  }

  conversation(taskId:string):Array<{id:string;role:string;content:string;createdAt:string}>{
    return this.store.listMessages(taskId).map((item)=>({id:item.id,role:item.role,content:item.content,createdAt:item.createdAt}));
  }

  async review(taskId:string):Promise<{originalPrompt:string;changedFiles:string[];checks:Array<{name:string;status:string}>;urls:string[];integrationState:string}>{
    const task=this.store.getTaskInfo(taskId);
    const project=this.store.getProjectInfo(task.projectId);
    const root=task.worktreePath ?? project.repoPath;
    const committed=await exec("git",["diff","--name-only",`${project.defaultBranch}...HEAD`],{cwd:root,encoding:"utf8",windowsHide:true,timeout:10_000}).then(r=>r.stdout.split(/\r?\n/u).filter(Boolean),()=>[]);
    const status=await exec("git",["status","--porcelain=v1"],{cwd:root,encoding:"utf8",windowsHide:true,timeout:10_000}).then(r=>r.stdout.split(/\r?\n/u).filter(Boolean).map(line=>line.slice(3).split(" -> ").at(-1)).filter((path):path is string=>typeof path==="string"&&path.length>0),()=>[]);
    const changedFiles=[...new Set([...committed,...status])].sort();
    const artifact=this.store.latestArtifact(taskId,"review");
    const checks=Array.isArray(artifact?.metadata.checks)
      ? artifact.metadata.checks.flatMap(item=>item&&typeof item==="object"&&typeof (item as Record<string,unknown>).name==="string"&&typeof (item as Record<string,unknown>).status==="string"
        ? [{name:(item as Record<string,unknown>).name as string,status:(item as Record<string,unknown>).status as string}]:[])
      : [];
    const urls=Array.isArray(artifact?.metadata.urls)?artifact.metadata.urls.filter((x):x is string=>typeof x==="string"):[];
    return {originalPrompt:task.originalPrompt,changedFiles,checks,urls,integrationState:task.integrationState};
  }

  async fileDiff(taskId:string,relativePath:string):Promise<{binary:boolean;model?:DiffModel}>{
    const task=this.store.getTaskInfo(taskId);
    const project=this.store.getProjectInfo(task.projectId);
    const root=task.worktreePath ?? project.repoPath;
    const path=resolveWithin(root,relativePath);
    const decode=(bytes:Uint8Array):string=>new TextDecoder("utf-8",{fatal:true}).decode(bytes);
    let oldText="";
    try{
      const result=await exec("git",["show",`${project.defaultBranch}:${relativePath}`],{cwd:root,encoding:"buffer",windowsHide:true,timeout:10_000,maxBuffer:16*1024*1024});
      oldText=decode(result.stdout);
    }catch(error){
      const e=error as Error&{stdout?:Buffer};
      if(e.stdout?.length){try{oldText=decode(e.stdout);}catch{return {binary:true};}}
    }
    let newText="";
    try{newText=decode(await readFile(path));}
    catch(error){
      const code=(error as NodeJS.ErrnoException).code;
      if(code!=="ENOENT"){
        if(error instanceof TypeError)return {binary:true};
        try{newText=decode(await readFile(path));}catch{return {binary:true};}
      }
    }
    return {binary:false,model:compareText(oldText,newText)};
  }

  async files(taskId:string,maxEntries=800):Promise<Array<{path:string;uri:string;isDirectory:boolean}>>{
    const task=this.store.getTaskInfo(taskId);
    const project=this.store.getProjectInfo(task.projectId);
    const root=task.worktreePath ?? project.repoPath;
    const output:Array<{path:string;uri:string;isDirectory:boolean}>=[];
    const walk=async(relative:string):Promise<void>=>{
      if(output.length>=maxEntries)return;
      const absolute=relative?join(root,relative):root;
      const entries=await readdir(absolute,{withFileTypes:true});
      for(const entry of entries.sort((a,b)=>a.name.localeCompare(b.name))){
        if(output.length>=maxEntries)return;
        if(entry.name===".git"||entry.name==="node_modules"||entry.isSymbolicLink())continue;
        const next=relative?relative+"/"+entry.name:entry.name;
        output.push({path:next,uri:pathToFileURL(join(root,...next.split("/"))).toString(),isDirectory:entry.isDirectory()});
        if(entry.isDirectory())await walk(next);
      }
    };
    await walk("");
    return output;
  }
}
