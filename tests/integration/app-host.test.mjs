import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApplicationController } from "@awi/app-host";
import { StateStore } from "@awi/persistence";

test("앱 호스트는 저장된 프로젝트/작업을 엔진 부재 상태에서도 대시보드로 복원한다",async(t)=>{
 const dir=await mkdtemp(join(tmpdir(),"awi-host-"));
 t.after(()=>rm(dir,{recursive:true,force:true}));
 const store=await StateStore.open(join(dir,"state.sqlite"));
 t.after(()=>store.close());
 const project=store.createProject("P",dir,"host-"+Date.now(),"main");
 store.createDiscussion(project,"원래 요청");
 const runtime={async subagents(){throw new Error("offline");}};
 const host=new ApplicationController(store,runtime);
 const data=await host.snapshot();
 assert.equal(data.projects.length,1);
 assert.equal(data.tasks[0].originalPrompt,"원래 요청");
 assert.deepEqual(data.agents,[]);
});
