import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateStore } from "@awi/persistence";

test("취소/완료 기록은 삭제하지 않고 명시적 보관 시 archived로 이동한다",async(t)=>{
  const dir=await mkdtemp(join(tmpdir(),"awi-life-"));
  const store=await StateStore.open(join(dir,"state.sqlite"));
  t.after(async()=>{store.close();await rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100});});
  const project=store.createProject("P",dir,"repo-"+Date.now(),"main");
  const task=store.createDiscussion(project,"원래 요청");
  store.setTaskDisposition(task,"cancelled");
  assert.equal(store.getTaskInfo(task).disposition,"cancelled");
  store.archiveTask(task);
  assert.equal(store.getTaskInfo(task).phase,"archived");
});
