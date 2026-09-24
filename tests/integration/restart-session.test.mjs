import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateStore } from "@awi/persistence";
import { SettingsRegistry } from "@awi/settings";

test("task settings와 OMP session artifact는 앱 메모리와 독립적으로 복원 가능하다",async(t)=>{
 const dir=await mkdtemp(join(tmpdir(),"awi-restore-"));
 const store=await StateStore.open(join(dir,"state.sqlite"));
 t.after(async()=>{store.close();await rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100});});
 const project=store.createProject("P",dir,"key-"+Date.now(),"main");
 const task=store.createDiscussion(project,"x");
 const snapshot={taskId:task,projectId:project,engine:"omp",model:"m",mode:"manual",capturedAt:new Date().toISOString(),sourceRevision:0};
 store.saveSettingsSnapshot("task",task,snapshot);
 store.saveArtifact(task,"omp-session","session.jsonl",{phase:"discussion",cwd:dir});
 assert.equal(store.latestArtifact(task,"omp-session").location,"session.jsonl");
 const registry=new SettingsRegistry();
 registry.restoreTask(snapshot);
 assert.equal(registry.taskSnapshot(task).model,"m");
});
