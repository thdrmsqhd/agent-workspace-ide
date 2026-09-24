"use strict";
Object.defineProperty(exports,"__esModule",{value:true});
const { ContainerModule }=require("@theia/core/shared/inversify");
const {
  BaseWidget,FrontendApplicationContribution,WidgetFactory,WidgetManager,
  WebSocketConnectionProvider,OpenerService,open
}=require("@theia/core/lib/browser");
const URI=require("@theia/core/lib/common/uri").default;
const { CommandRegistry }=require("@theia/core/lib/common");
const { AWI_SERVICE_PATH }=require("../common/protocol");
const WIDGET_ID="awi.dashboard";

function el(name,text,className){
  const node=document.createElement(name);
  if(text!==undefined)node.textContent=text;
  if(className)node.className=className;
  return node;
}
function button(label,action){
  const b=el("button",label,"awi-btn");b.type="button";b.onclick=()=>void action();return b;
}
function input(placeholder){
  const i=el("input");i.placeholder=placeholder;return i;
}
function renderReviewDiff(container,result){
  container.replaceChildren();
  if(result.binary){container.append(el("div","바이너리 파일은 텍스트 Diff로 표시하지 않습니다.","awi-card"));return;}
  const model=result.model;if(!model)return;
  const wrap=el("div");wrap.style.display="grid";wrap.style.gridTemplateColumns="1fr 90px 1fr";wrap.style.height="420px";
  const left=el("ol");const links=el("div");const right=el("ol");
  for(const pane of [left,right]){pane.style.overflow="auto";pane.style.margin="0";pane.style.padding="8px 8px 24px 54px";pane.style.whiteSpace="pre";pane.style.fontFamily="monospace";}
  const blockFor=(side,index)=>model.blocks.find(b=>{const s=side==="old"?b.oldStart:b.newStart;const e=side==="old"?b.oldEnd:b.newEnd;return s===e?index===s:index>=s&&index<e;});
  const fill=(pane,source,side)=>source.forEach((line,index)=>{const li=el("li",line.text||" ");li.dataset.line=String(index);const b=blockFor(side,index);
    if(b)li.style.background=b.kind==="insert"?"rgba(70,160,90,.20)":b.kind==="delete"?"rgba(210,70,70,.18)":"rgba(200,155,60,.16)";pane.append(li);});
  fill(left,model.oldLines,"old");fill(right,model.newLines,"new");
  links.style.overflow="auto";links.style.borderLeft="1px solid #555";links.style.borderRight="1px solid #555";
  model.blocks.forEach((b,index)=>{links.append(button(`${index+1} · ${b.kind}`,()=>{left.querySelector(`[data-line="${b.oldStart}"]`)?.scrollIntoView({block:"center"});right.querySelector(`[data-line="${b.newStart}"]`)?.scrollIntoView({block:"center"});}));});
  wrap.append(left,links,right);container.append(wrap);
}

class AwiDashboardWidget extends BaseWidget{
  constructor(service,opener,commands){
    super();
    this.service=service;this.opener=opener;this.commands=commands;this.data={projects:[],tasks:[],agents:[]};this.activeTask=undefined;
    this.importPreview=undefined;this.importSelected=new Set();
    this.id=WIDGET_ID;this.title.label="Agent Workspace";this.title.caption="Agent Workspace";this.title.closable=false;
    this.node.classList.add("awi-dashboard-root");
    void this.refresh();
  }
  async refresh(){
    this.data=await this.service.snapshot();
    if(this.activeTask && !this.data.tasks.some(t=>t.id===this.activeTask))this.activeTask=undefined;
    this.update();
  }
  async selectTask(taskId){this.activeTask=taskId;await this.service.syncTask(taskId).catch(()=>undefined);this.update();}
  async action(fn){try{await fn();await this.refresh();}catch(error){window.alert(error instanceof Error?error.message:String(error));}}
  onUpdateRequest(){
    const root=this.node;root.replaceChildren();
    const style=el("style");
    style.textContent=`
      .awi-dashboard-root{height:100%;overflow:hidden;font-family:var(--theia-ui-font-family)}
      .awi-topbar{display:flex;gap:6px;padding:8px;border-bottom:1px solid var(--theia-border-color);flex-wrap:wrap}
      .awi-topbar input,.awi-topbar select,.awi-compose{min-width:120px;background:var(--theia-input-background);color:var(--theia-input-foreground);border:1px solid var(--theia-input-border);padding:5px}
      .awi-body{display:grid;grid-template-columns:240px minmax(320px,1fr) 280px;height:calc(100% - 96px)}
      .awi-pane{overflow:auto;padding:8px;border-right:1px solid var(--theia-border-color)}
      .awi-pane:last-child{border-right:0;border-left:1px solid var(--theia-border-color)}
      .awi-card{padding:8px;margin:6px 0;border:1px solid var(--theia-border-color);border-radius:4px}
      .awi-btn{margin:2px;padding:4px 8px}.awi-file{display:block;width:100%;text-align:left;background:transparent;color:inherit;border:0;padding:3px}
      .awi-message{padding:6px;margin:4px 0;border-left:3px solid var(--theia-border-color);white-space:pre-wrap}
      .awi-compose{width:calc(100% - 16px);min-height:72px}
    `;
    root.append(style);
    const top=el("div",undefined,"awi-topbar");
    const name=input("프로젝트 이름");const path=input("Git 프로젝트 경로");const model=input("OMP 모델(provider/model)");
    const branch=input("기준 브랜치");branch.value="main";
    top.append(name,path,model,branch,button("프로젝트 등록",()=>this.action(async()=>{
      if(!name.value.trim()||!path.value.trim()||!model.value.trim())throw new Error("프로젝트 이름·경로·모델이 필요합니다.");
      await this.service.registerProject(name.value,path.value,branch.value||"main",model.value,"manual");
    })));
    const projectSelect=el("select");
    projectSelect.append(el("option","새 요청 프로젝트"));
    for(const p of this.data.projects){const o=el("option",p.name);o.value=p.id;projectSelect.append(o);}
    const prompt=input("새 요청");
    const defaultModel=input("프로젝트 기본 모델");const mode=el("select");for(const v of ["manual","automatic"]){const o=el("option",v);o.value=v;mode.append(o);}
    top.append(projectSelect,prompt,button("새 요청",()=>this.action(async()=>{
      if(!projectSelect.value||!prompt.value.trim())throw new Error("프로젝트와 요청을 입력하세요.");
      const taskId=await this.service.createRequest(projectSelect.value,prompt.value);this.activeTask=taskId;
    })),defaultModel,mode,button("프로젝트 설정 적용",()=>this.action(async()=>{
      if(!projectSelect.value||!defaultModel.value.trim())throw new Error("프로젝트와 모델이 필요합니다.");
      const current=await this.service.projectSettings(projectSelect.value);if(!current)throw new Error("프로젝트 설정이 없습니다.");
      await this.service.updateProjectSettings(projectSelect.value,defaultModel.value,mode.value,current.revision);
    })));
    root.append(top);

    const importBox=el("details",undefined,"awi-card");importBox.append(el("summary","기존 OMP 세션 가져오기"));
    const importProject=el("select");importProject.append(el("option","프로젝트 선택"));
    for(const p of this.data.projects){const o=el("option",p.name);o.value=p.id;importProject.append(o);}
    const sessionPath=input("기존 OMP 세션 경로");const sourcePath=input("원본 Git 작업폴더(선택 변경)");
    const importPrompt=input("연결 작업 설명");const importBase=input("기준 브랜치");importBase.value="main";
    importBox.append(importProject,sessionPath,sourcePath,importPrompt,importBase,
      button("변경 미리보기",()=>this.action(async()=>{
        if(!sourcePath.value.trim())throw new Error("원본 작업폴더 경로가 필요합니다.");
        this.importPreview=await this.service.previewImport(sourcePath.value);
        this.importSelected=new Set(this.importPreview.files.map(f=>f.id));this.update();
      })));
    if(this.importPreview){
      const list=el("div");
      for(const file of this.importPreview.files){
        const label=el("label");const check=el("input");check.type="checkbox";check.checked=this.importSelected.has(file.id);
        check.onchange=()=>check.checked?this.importSelected.add(file.id):this.importSelected.delete(file.id);
        label.append(check,document.createTextNode(` ${file.kind} · ${file.oldPath||""}${file.newPath&&file.oldPath!==file.newPath?" → "+file.newPath:file.newPath||""}`));list.append(label,el("br"));
      }
      importBox.append(list,button("선택 항목으로 세션 가져오기",()=>this.action(async()=>{
        if(!importProject.value||!sessionPath.value.trim())throw new Error("프로젝트와 OMP 세션 경로가 필요합니다.");
        const taskId=await this.service.importExistingSession({
          projectId:importProject.value,originalPrompt:importPrompt.value||"기존 세션 이어가기",
          sessionPath:sessionPath.value,baseRef:importBase.value||"main",
          sourcePath:sourcePath.value||undefined,selectedChangeIds:[...this.importSelected]
        });
        this.activeTask=taskId;this.importPreview=undefined;this.importSelected.clear();
      })));
    }
    root.append(importBox);

    const body=el("div",undefined,"awi-body");
    const left=el("section",undefined,"awi-pane");left.append(el("h3","파일"));
    const center=el("main",undefined,"awi-pane");center.append(el("h3",this.activeTask?"작업":"전체 현황"));
    const right=el("aside",undefined,"awi-pane");right.append(el("h3","프로젝트 · 세션"));

    if(this.activeTask){
      void this.service.files(this.activeTask).then(files=>{
        if(this.activeTask===undefined)return;
        left.replaceChildren(el("h3","파일"));
        for(const f of files){
          const b=button((f.isDirectory?"▸ ":"")+f.path,async()=>{
            if(!f.isDirectory)await open(this.opener,new URI(f.uri));
          });b.className="awi-file";left.append(b);
        }
      }).catch(()=>undefined);
      const task=this.data.tasks.find(t=>t.id===this.activeTask);
      if(task){
        center.append(el("div",task.originalPrompt,"awi-card"));
        const controls=el("div");
        if(task.status==="idle"||task.status==="discussion")controls.append(button("작업 시작",()=>this.action(()=>this.service.beginTask(task.id))));
        if(task.status==="running")controls.append(button("중단",()=>this.action(()=>this.service.abortTask(task.id))));
        if(task.status==="paused")controls.append(button("재개",()=>this.action(()=>this.service.resumeTask(task.id))));
        controls.append(button("취소",()=>this.action(()=>this.service.cancelTask(task.id))));
        if(task.archived===false && task.status!=="running")controls.append(button("보관",()=>this.action(()=>this.service.archiveTask(task.id))));
        controls.append(
          button("작업 터미널",()=>this.action(async()=>{
            const ctx=await this.service.taskContext(task.id);
            await this.commands.executeCommand("openInTerminal",new URI(ctx.rootUri));
          })),
          button("Run / Debug",()=>this.action(()=>this.commands.executeCommand("debug:toggle")))
        );
        controls.append(button("결과 검토",()=>this.action(async()=>{
          const review=await this.service.review(task.id);
          const panel=el("section",undefined,"awi-card");panel.append(el("h3","결과 검토"),el("div",`반영 상태: ${review.integrationState}`));
          for(const check of review.checks)panel.append(el("div",`${check.name}: ${check.status}`));
          for(const url of review.urls)panel.append(el("div",url));
          const diffHost=el("div");panel.append(diffHost);
          for(const file of review.changedFiles)panel.append(button(file,async()=>renderReviewDiff(diffHost,await this.service.fileDiff(task.id,file))));
          center.append(panel);
        })));
        center.append(controls);
        void this.service.conversation(task.id).then(messages=>{
          for(const old of center.querySelectorAll(".awi-message"))old.remove();
          for(const m of messages)center.append(el("div",`${m.role}: ${m.content}`,"awi-message"));
        }).catch(()=>undefined);
        for(const request of task.inputRequests||[]){
          const box=el("div",undefined,"awi-card");box.append(el("div",request.message));
          const answer=input("답변");box.append(answer,button("응답",()=>this.action(()=>this.service.respondInput(task.id,request.id,answer.value))));center.append(box);
        }
        if(task.queue?.length){
          center.append(el("h4","대기 지시"));
          for(const queued of task.queue.filter(item=>item.state!=="deleted"&&item.state!=="finished")){
            const row=el("div",undefined,"awi-card");const edit=input("대기 지시");edit.value=queued.text;
            row.append(el("span",queued.state),edit,
              button("수정",()=>this.action(()=>this.service.updateQueued(task.id,queued.id,queued.revision,edit.value))),
              button("삭제",()=>this.action(()=>this.service.deleteQueued(task.id,queued.id,queued.revision))));
            center.append(row);
          }
        }
        const attachRow=el("div",undefined,"awi-card");const attachKind=el("select");
        for(const k of ["file","folder","image"]){const o=el("option",k);o.value=k;attachKind.append(o);}
        const attachPath=input("워크트리 상대 경로");
        attachRow.append(attachKind,attachPath,button("첨부 추가",()=>this.action(()=>this.service.addAttachment(task.id,attachKind.value,attachPath.value))));
        center.append(attachRow);
        void this.service.attachments(task.id).then(items=>{
          for(const old of center.querySelectorAll(".awi-attachment-row"))old.remove();
          for(const item of items){const row=el("div",`${item.kind}: ${item.relativePath}`,"awi-attachment-row");
            row.append(button("제거",()=>this.action(()=>this.service.removeAttachment(task.id,item.id))));center.append(row);}
        }).catch(()=>undefined);
        const taskModel=input("작업 모델(provider/model)");
        center.append(taskModel,button("작업 모델 변경",()=>this.action(async()=>{
          const slash=taskModel.value.indexOf("/");if(slash<1)throw new Error("provider/model 형식이 필요합니다.");
          await this.service.changeModel(task.id,taskModel.value.slice(0,slash),taskModel.value.slice(slash+1));
        })));
        const compose=el("textarea");compose.className="awi-compose";compose.placeholder="추가 지시";
        center.append(compose,button("즉시 전달",()=>this.action(()=>this.service.sendTask(task.id,compose.value,"immediate"))),
          button("대기열",()=>this.action(()=>this.service.sendTask(task.id,compose.value,"queued"))));
      }
    }else{
      for(const project of this.data.projects){
        center.append(el("h4",project.name));
        for(const task of this.data.tasks.filter(t=>t.projectId===project.id)){
          const card=el("div",undefined,"awi-card");
          card.append(el("div",task.originalPrompt),el("div",`${task.status} · 변경 ${task.changedFileCount} · 응답 ${task.pendingInputCount}`),
            button("열기",()=>this.selectTask(task.id)));
          center.append(card);
        }
      }
    }

    for(const project of this.data.projects){
      right.append(el("h4",project.name));
      for(const task of this.data.tasks.filter(t=>t.projectId===project.id)){
        const agents=this.data.agents.filter(a=>a.taskId===task.id);
        right.append(button(`${task.pendingInputCount?"● ":""}${task.originalPrompt.slice(0,28)} (${agents.length})`,()=>this.selectTask(task.id)));
        for(const agent of agents)right.append(el("div",`↳ ${agent.currentAction||agent.status}`));
      }
    }
    body.append(left,center,right);root.append(body);
  }
}

exports.default=new ContainerModule(bind=>{
  bind("AwiBackendProxy").toDynamicValue(ctx=>ctx.container.get(WebSocketConnectionProvider).createProxy(AWI_SERVICE_PATH)).inSingletonScope();
  bind(WidgetFactory).toDynamicValue(ctx=>({
    id:WIDGET_ID,
    createWidget:()=>new AwiDashboardWidget(ctx.container.get("AwiBackendProxy"),ctx.container.get(OpenerService),ctx.container.get(CommandRegistry))
  })).inSingletonScope();
  bind(FrontendApplicationContribution).toDynamicValue(ctx=>({
    initializeLayout:async app=>{
      const widget=await ctx.container.get(WidgetManager).getOrCreateWidget(WIDGET_ID);
      if(!widget.isAttached)app.shell.addWidget(widget,{area:"main"});
      app.shell.activateWidget(WIDGET_ID);
    }
  })).inSingletonScope();
});
