import { agentTree, fileContextTask, projectCards, type AgentTreeNode, type ViewAction, type ViewState, type WorkspaceData } from "./index.js";

export interface WorkspaceCallbacks {
  dispatch(action: ViewAction): void;
  createDiscussion(projectId: string, prompt: string): void;
  sendTask?(taskId: string, text: string, delivery: "immediate" | "queued"): void;
  abortTask?(taskId: string): void;
  resumeTask?(taskId: string): void;
  cancelTask?(taskId: string): void;
  beginTask?(taskId: string): void;
  updateQueued?(taskId: string, messageId: string, revision: number, text: string): void;
  deleteQueued?(taskId: string, messageId: string, revision: number): void;
  respondInput?(taskId: string, inputRequestId: string, response: string | boolean): void;
  addAttachment?(taskId: string, kind: "file" | "folder" | "image" | "code-selection"): void;
  openFile?(taskId: string, relativePath: string): void;
  respondInput?(taskId: string, inputRequestId: string, text: string): void;
  cancelTask?(taskId: string): void;
  archiveTask?(taskId: string): void;
  addAttachment?(taskId: string): void;
  removeAttachment?(taskId: string, attachmentId: string): void;
}

export interface FileEntry { path: string; isDirectory: boolean }

function node<K extends keyof HTMLElementTagNameMap>(doc: Document, name: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const item = doc.createElement(name);
  if (className) item.className = className;
  if (text !== undefined) item.textContent = text;
  return item;
}

function button(doc: Document, label: string, onClick: () => void): HTMLButtonElement {
  const item = node(doc, "button", "awi-button", label);
  item.type = "button";
  item.addEventListener("click", onClick);
  return item;
}

/** IDE 호스트가 데이터를 전달하는 화면 껍질. 호스트가 없는 기능은 호출하지 않는다. */
export function renderWorkspace(
  root: HTMLElement,
  state: ViewState,
  data: WorkspaceData,
  callbacks: WorkspaceCallbacks,
  files: readonly FileEntry[] = [],
): void {
  const doc = root.ownerDocument;
  const shell = node(doc, "div", "awi-shell");
  const header = node(doc, "header", "awi-top");
  const projectSelect = node(doc, "select", "awi-project-select");
  projectSelect.setAttribute("aria-label", "새 요청 프로젝트");
  projectSelect.append(node(doc, "option", undefined, "프로젝트 선택"));
  projectSelect.options[0]!.value = "";
  for (const project of data.projects) {
    const option = node(doc, "option", undefined, project.name);
    option.value = project.id;
    projectSelect.append(option);
  }
  projectSelect.value = state.selectedNewProjectId ?? "";
  projectSelect.addEventListener("change", () => {
    if (projectSelect.value) callbacks.dispatch({ kind: "selectNewProject", projectId: projectSelect.value });
  });
  const prompt = node(doc, "textarea", "awi-new-prompt");
  prompt.setAttribute("aria-label", "새 요청");
  prompt.placeholder = "선택한 프로젝트에 새 요청";
  prompt.value = state.newRequestDrafts[state.selectedNewProjectId ?? ""] ?? "";
  prompt.addEventListener("input", () => {
    if (projectSelect.value) callbacks.dispatch({ kind: "setNewDraft", projectId: projectSelect.value, text: prompt.value });
  });
  const submit = () => {
    if (projectSelect.value && prompt.value.trim()) callbacks.createDiscussion(projectSelect.value, prompt.value);
  };
  prompt.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) { event.preventDefault(); submit(); }
  });
  header.append(projectSelect, prompt, button(doc, "새 요청", submit));
  shell.append(header);

  const body = node(doc, "div", "awi-body");
  const left = node(doc, "aside", `awi-files ${state.leftCollapsed ? "awi-collapsed" : ""}`);
  left.append(button(doc, state.leftCollapsed ? "파일 열기" : "파일 접기", () => callbacks.dispatch({ kind: "toggleLeft" })));
  if (!state.leftCollapsed) {
    const current = fileContextTask(state);
    left.append(node(doc, "h2", undefined, current ? `작업 ${current} 파일` : "파일을 볼 작업을 선택하세요"));
    if (current) {
      const list = node(doc, "ul", "awi-file-list");
      for (const file of files) {
        const item = node(doc, "li");
        item.append(button(doc, `${file.isDirectory ? "▸" : "◻"} ${file.path}`, () => {
          if (!file.isDirectory) callbacks.openFile?.(current, file.path);
        }));
        list.append(item);
      }
      left.append(list);
    }
  }
  body.append(left);

  const center = node(doc, "main", "awi-center");
  const tabs = node(doc, "nav", "awi-tabs");
  tabs.setAttribute("aria-label", "작업 탭");
  tabs.append(button(doc, "전체 현황", () => callbacks.dispatch({ kind: "openOverview" })));
  for (const taskId of state.taskTabs) {
    const task = data.tasks.find((item) => item.id === taskId);
    if (!task) continue;
    const tab = node(doc, "div", "awi-tab");
    tab.append(button(doc, task.originalPrompt.slice(0, 24), () => callbacks.dispatch({ kind: "openTask", taskId })));
    tab.append(button(doc, "닫기", () => callbacks.dispatch({ kind: "closeTaskTab", taskId })));
    tabs.append(tab);
  }
  center.append(tabs);
  if (state.activeTab === "overview") {
    for (const project of data.projects) {
      const section = node(doc, "section", "awi-project-cards");
      section.append(node(doc, "h2", undefined, project.name));
      const cards = projectCards(data, project.id);
      for (const task of cards.active) {
        const card = node(doc, "article", "awi-card");
        card.append(node(doc, "p", "awi-original-request", task.originalPrompt));
        card.append(node(doc, "p", undefined, `${task.status} · 변경 ${task.changedFileCount}개 · 응답 ${task.pendingInputCount}개`));
        if (task.currentAction) card.append(node(doc, "p", undefined, task.currentAction));
        card.append(button(doc, "작업 열기", () => callbacks.dispatch({ kind: "openTask", taskId: task.id })));
        section.append(card);
      }
      if (cards.archived.length) {
        const archived = node(doc, "details");
        archived.append(node(doc, "summary", undefined, `완료·취소 ${cards.archived.length}개`));
        for (const task of cards.archived) archived.append(button(doc, task.originalPrompt, () => callbacks.dispatch({ kind: "openTask", taskId: task.id })));
        section.append(archived);
      }
      center.append(section);
    }
  } else {
    const task = data.tasks.find((item) => item.id === state.activeTab);
    if (task) {
      const conversation = node(doc, "section", "awi-conversation");
      conversation.append(node(doc, "h2", undefined, task.originalPrompt));
      conversation.append(node(doc, "p", undefined, `상태: ${task.status} · 현재: ${task.currentAction ?? "확인 중"}`));
      const pending = (data.inputRequests ?? []).filter((item) => item.taskId === task.id);
      for (const request of pending) {
        const box = node(doc, "section", "awi-input-request");
        box.append(node(doc, "p", undefined, `응답 필요: ${request.prompt}`));
        const answer = node(doc, "input");
        answer.setAttribute("aria-label", "빠른 답변");
        answer.addEventListener("keydown", (event) => {
          if (event.key === "Enter" && !event.isComposing && answer.value.trim()) {
            callbacks.respondInput?.(task.id, request.id, answer.value);
          }
        });
        box.append(answer, button(doc, "답변", () => {
          if (answer.value.trim()) callbacks.respondInput?.(task.id, request.id, answer.value);
        }));
        conversation.append(box);
      }
      const attachments = (data.attachments ?? []).filter((item) => item.taskId === task.id);
      if (callbacks.addAttachment) conversation.append(button(doc, "첨부 추가", () => callbacks.addAttachment?.(task.id)));
      if (attachments.length) {
        const list = node(doc, "ul", "awi-attachments");
        for (const attachment of attachments) {
          const item = node(doc, "li", undefined, `${attachment.kind} · ${attachment.label}`);
          if (callbacks.removeAttachment) item.append(button(doc, "제거", () => callbacks.removeAttachment?.(task.id, attachment.id)));
          list.append(item);
        }
        conversation.append(list);
      }
      if (callbacks.beginTask && task.status === "discussion") conversation.append(button(doc, "작업 시작", () => callbacks.beginTask?.(task.id)));
      if (callbacks.abortTask && task.status === "running") conversation.append(button(doc, "중단", () => callbacks.abortTask?.(task.id)));
      if (callbacks.cancelTask && !task.archived) conversation.append(button(doc, "취소", () => callbacks.cancelTask?.(task.id)));
      if (callbacks.archiveTask && task.status !== "running" && !task.archived) conversation.append(button(doc, "보관", () => callbacks.archiveTask?.(task.id)));
      if (callbacks.resumeTask && (task.status === "paused" || task.status === "failed")) conversation.append(button(doc, "재개", () => callbacks.resumeTask?.(task.id)));
      if (callbacks.cancelTask && !task.archived) conversation.append(button(doc, "작업 취소", () => callbacks.cancelTask?.(task.id)));
      for (const request of task.inputRequests ?? []) {
        const panel = node(doc, "section", "awi-input-request");
        panel.append(node(doc, "strong", undefined, request.title ?? "응답 필요"));
        panel.append(node(doc, "p", undefined, request.message));
        for (const option of request.options ?? []) {
          panel.append(button(doc, option, () => callbacks.respondInput?.(task.id, request.id, option)));
        }
        if (!(request.options?.length)) {
          const answer = node(doc, "input");
          answer.setAttribute("aria-label", "빠른 응답");
          panel.append(answer, button(doc, "응답", () => {
            if (answer.value.trim()) callbacks.respondInput?.(task.id, request.id, answer.value);
          }));
        }
        conversation.append(panel);
      }
      if ((task.queue?.length ?? 0) > 0) {
        const queue = node(doc, "section", "awi-queue");
        queue.append(node(doc, "h3", undefined, "대기 지시"));
        for (const item of task.queue ?? []) {
          if (item.state === "deleted" || item.state === "finished") continue;
          const row = node(doc, "div", "awi-queue-row");
          if (item.state === "queued") {
            const edit = node(doc, "input");
            edit.value = item.text;
            row.append(edit);
            if (callbacks.updateQueued) row.append(button(doc, "수정", () => callbacks.updateQueued?.(task.id, item.id, item.revision, edit.value)));
            if (callbacks.deleteQueued) row.append(button(doc, "삭제", () => callbacks.deleteQueued?.(task.id, item.id, item.revision)));
          } else {
            row.append(node(doc, "span", undefined, `${item.text} · ${item.state === "dispatching" ? "전달 중" : item.state}`));
          }
          queue.append(row);
        }
        conversation.append(queue);
      }
      if (callbacks.addAttachment) {
        const attach = node(doc, "div", "awi-attachments");
        for (const kind of ["file","folder","image","code-selection"] as const) {
          attach.append(button(doc, `${kind} 첨부`, () => callbacks.addAttachment?.(task.id, kind)));
        }
        conversation.append(attach);
      }
      if (callbacks.sendTask) {
        const input = node(doc, "textarea", "awi-task-prompt");
        input.value = state.drafts[task.id] ?? "";
        input.setAttribute("aria-label", "작업 추가 지시");
        input.addEventListener("input", () => callbacks.dispatch({ kind: "setDraft", taskId: task.id, text: input.value }));
        const mode = node(doc, "select");
        mode.setAttribute("aria-label", "전송 방식");
        for (const optionName of ["immediate", "queued"] as const) {
          const option = node(doc, "option", undefined, optionName === "immediate" ? "즉시" : "대기열");
          option.value = optionName;
          mode.append(option);
        }
        const send = () => { if (input.value.trim()) callbacks.sendTask?.(task.id, input.value, mode.value as "immediate" | "queued"); };
        input.addEventListener("keydown", (event) => {
          if (event.key === "Enter" && !event.shiftKey && !event.isComposing) { event.preventDefault(); send(); }
        });
        conversation.append(input, mode, button(doc, "지시 전달", send));
      }
      const review = (data.reviews ?? []).find((item) => item.taskId === task.id);
      if (review) {
        const panel = node(doc, "section", "awi-review");
        panel.append(node(doc, "h3", undefined, "결과 검토"));
        panel.append(node(doc, "p", undefined, review.summary));
        panel.append(node(doc, "p", undefined, `변경 파일 ${review.changedFiles.length}개`));
        for (const check of review.checks) panel.append(node(doc, "p", undefined, `${check.name}: ${check.status}`));
        for (const url of review.urls) panel.append(node(doc, "p", undefined, url));
        conversation.append(panel);
      }
      center.append(conversation);
    }
  }
  body.append(center);

  const right = node(doc, "aside", `awi-sessions ${state.rightCollapsed ? "awi-collapsed" : ""}`);
  const appendAgent = (group: HTMLElement, agent: AgentTreeNode, depth: number) => {
    const label = `${"↳ ".repeat(Math.min(depth, 5))}${agent.currentAction ?? agent.status}`;
    group.append(button(doc, label, () => callbacks.dispatch({ kind: "toggleAgent", agentId: agent.id })));
    if (state.expandedAgentIds.has(agent.id)) {
      for (const child of agent.children) appendAgent(group, child, depth + 1);
    }
  };
  right.append(button(doc, state.rightCollapsed ? "프로젝트 펼치기" : "프로젝트 접기", () => callbacks.dispatch({ kind: "toggleRight" })));
  if (!state.rightCollapsed) {
    for (const project of data.projects) {
      const group = node(doc, "section", "awi-session-group");
      group.append(button(doc, project.name, () => callbacks.dispatch({ kind: "toggleProject", projectId: project.id })));
      if (state.expandedProjectIds.has(project.id)) {
        for (const task of data.tasks.filter((item) => item.projectId === project.id)) {
          group.append(button(doc, `${task.pendingInputCount ? "응답 필요 · " : ""}${task.originalPrompt.slice(0, 32)}`, () => callbacks.dispatch({ kind: "openTask", taskId: task.id })));
          const agents = agentTree(data.agents, task.id);
          for (const main of agents.roots) appendAgent(group, main, 1);
          if (agents.unresolved.length) group.append(node(doc, "p", undefined, "에이전트 관계 확인 중"));
        }
      }
      right.append(group);
    }
  }
  body.append(right);
  shell.append(body);
  root.replaceChildren(shell);
}
