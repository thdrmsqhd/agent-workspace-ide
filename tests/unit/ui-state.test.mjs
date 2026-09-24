import { test } from "node:test";
import assert from "node:assert/strict";
import { agentTree, createInitialView, fileContextTask, projectCards, projectForNewRequest, reduceView } from "@awi/ui";

const data = {
  projects: [{ id: "P1", name: "첫 프로젝트", createdAt: "1" }, { id: "P2", name: "다음 프로젝트", createdAt: "2" }],
  tasks: [
    { id: "A", projectId: "P1", originalPrompt: "첫 요청", createdAt: "1", status: "running", changedFileCount: 2, pendingInputCount: 0, archived: false },
    { id: "B", projectId: "P2", originalPrompt: "다음 요청", createdAt: "2", status: "waiting", changedFileCount: 0, pendingInputCount: 1, archived: false },
  ], agents: [],
};

test("상단 새 요청 대상과 왼쪽 파일 대상은 서로 독립적이다", () => {
  let view = createInitialView();
  view = reduceView(view, { kind: "selectNewProject", projectId: "P2" }, data);
  view = reduceView(view, { kind: "openTask", taskId: "A" }, data);
  assert.equal(projectForNewRequest(view), "P2");
  assert.equal(fileContextTask(view), "A");
  view = reduceView(view, { kind: "openTask", taskId: "B" }, data);
  assert.deepEqual(view.taskTabs, ["A", "B"]);
  assert.equal(fileContextTask(view), "B");
  assert.equal(projectForNewRequest(view), "P2");
});

test("작업 탭 닫기는 실행 모델과 초안을 보존하고 재열기한다", () => {
  let view = reduceView(createInitialView(), { kind: "openTask", taskId: "A" }, data);
  view = reduceView(view, { kind: "setDraft", taskId: "A", text: "추가 지시 초안" }, data);
  view = reduceView(view, { kind: "closeTaskTab", taskId: "A" }, data);
  assert.equal(view.activeTab, "overview");
  assert.equal(view.leftCollapsed, true);
  assert.equal(view.drafts.A, "추가 지시 초안");
  assert.equal(data.tasks[0].status, "running");
  view = reduceView(view, { kind: "openTask", taskId: "A" }, data);
  assert.deepEqual(view.taskTabs, ["A"]);
  assert.equal(view.drafts.A, "추가 지시 초안");
});

test("카드는 생성 순을 유지하고 부모가 불명확한 에이전트는 격리한다", () => {
  const ordered = { ...data, tasks: [data.tasks[0], { ...data.tasks[0], id: "done", archived: true, createdAt: "3" }] };
  assert.deepEqual(projectCards(ordered, "P1").active.map((task) => task.id), ["A"]);
  assert.deepEqual(projectCards(ordered, "P1").archived.map((task) => task.id), ["done"]);
  const tree = agentTree([
    { id: "main", taskId: "A", status: "running" },
    { id: "child", taskId: "A", parentAgentId: "main", status: "working" },
    { id: "orphan", taskId: "A", parentAgentId: "missing", status: "unknown" },
  ], "A");
  assert.equal(tree.roots[0].children[0].id, "child");
  assert.deepEqual(tree.unresolved.map((item) => item.id), ["orphan"]);
});

test("입력 요청·첨부·검토 데이터는 작업별로 격리된다", () => {
  const enriched = {
    ...data,
    inputRequests:[{id:"I1",taskId:"B",prompt:"승인?"}],
    attachments:[{id:"X1",taskId:"A",label:"a.txt",kind:"file"}],
    reviews:[{taskId:"A",summary:"완료",changedFiles:["a.txt"],checks:[{name:"unit",status:"not_run"}],urls:[]}]
  };
  assert.equal(enriched.inputRequests.filter((item)=>item.taskId==="A").length,0);
  assert.equal(enriched.attachments.filter((item)=>item.taskId==="A").length,1);
  assert.equal(enriched.reviews.find((item)=>item.taskId==="A").checks[0].status,"not_run");
});
