"use strict";
Object.defineProperty(exports,"__esModule",{value:true});
const { ContainerModule }=require("@theia/core/shared/inversify");
const { ConnectionHandler, JsonRpcConnectionHandler }=require("@theia/core/lib/common/messaging");
const { homedir }=require("node:os");
const { join }=require("node:path");
const { AWI_SERVICE_PATH }=require("../common/protocol");

const SERVICE=Symbol.for("awi.product.backend");

class AwiBackendService {
  constructor(){this._controllerPromise=undefined;}
  async controller(){
    if(!this._controllerPromise)this._controllerPromise=this.initialize();
    return this._controllerPromise;
  }
  async initialize(){
    const [
      {StateStore},{ProcessTreeSupervisor},{SettingsRegistry},
      {WorkspaceRuntime,OmpSessionFactory},{ApplicationController}
    ]=await Promise.all([
      import("@awi/persistence"),import("@awi/processes"),import("@awi/settings"),
      import("@awi/runtime"),import("@awi/app-host")
    ]);
    const root=process.env.AWI_DATA_DIR||join(homedir(),".agent-workspace-ide");
    const omp=process.env.AWI_OMP_BIN||join(homedir(),".bun","bin",process.platform==="win32"?"omp.exe":"omp");
    const store=await StateStore.open(join(root,"state.sqlite"));
    const supervisor=new ProcessTreeSupervisor();
    const settings=new SettingsRegistry();
    const factory=new OmpSessionFactory(supervisor,{
      executable:omp,sessionRoot:join(root,"sessions"),configRoot:join(root,"config")
    });
    const runtime=new WorkspaceRuntime({
      store,settings,supervisor,engineFactory:factory,
      worktreeRoot:join(root,"worktrees"),journalDirectory:join(root,"journals")
    });
    return new ApplicationController(store,runtime);
  }
  async snapshot(){return (await this.controller()).snapshot();}
  async registerProject(name,repoPath,defaultBranch,model,mode){return (await this.controller()).registerProject(name,repoPath,defaultBranch,model,mode);}
  async createRequest(projectId,prompt){return (await this.controller()).createRequest(projectId,prompt);}
  async beginTask(taskId,baseRef){return (await this.controller()).beginTask(taskId,baseRef);}
  async sendTask(taskId,text,mode){return (await this.controller()).sendTask(taskId,text,mode);}
  async abortTask(taskId){return (await this.controller()).abortTask(taskId);}
  async resumeTask(taskId){return (await this.controller()).resumeTask(taskId);}
  async cancelTask(taskId){return (await this.controller()).cancelTask(taskId);}
  async archiveTask(taskId){return (await this.controller()).archiveTask(taskId);}
  async respondInput(taskId,inputRequestId,response){return (await this.controller()).respondInput(taskId,inputRequestId,response);}
  async syncTask(taskId){return (await this.controller()).syncTask(taskId);}
  async conversation(taskId){return (await this.controller()).conversation(taskId);}
  async files(taskId){return (await this.controller()).files(taskId);}
}

exports.default=new ContainerModule(bind=>{
  bind(SERVICE).toDynamicValue(()=>new AwiBackendService()).inSingletonScope();
  bind(ConnectionHandler).toDynamicValue(ctx=>
    new JsonRpcConnectionHandler(AWI_SERVICE_PATH,()=>ctx.container.get(SERVICE))
  ).inSingletonScope();
});
