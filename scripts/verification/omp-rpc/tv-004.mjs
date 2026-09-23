// TV-004: 메인·하위 에이전트 트리 관측과 중단(Esc)이 자손까지 전파되는지 실제 엔진에서 확인한다.
// 판정 방법: 하위 에이전트가 실행하는 루프가 남기는 생존 표식 파일의 갱신이 중단 후 멈추는지,
// 그리고 다른 작업(독립 RPC 세션)의 표식은 계속 갱신되는지 mtime으로 대조한다.
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { OmpRpcClient } from "./client.mjs";
import { baseArgs, createProbeWorkspace, ompVersion, posixPath, resolveOmpBin } from "./probe.mjs";

export const name = "tv-004";
// 하위 에이전트 실행에는 실제 도구 호출이 필요하므로 인증이 확인된 기본 공급자 모델을 쓴다.
const promptModel = process.env.AWI_PROMPT_MODEL ?? "openai-codex/gpt-6-astra";

const markerLoop = (markerPath) => {
  const shellPath = posixPath(markerPath);
  return `while [ ! -f ${shellPath}.stop ]; do date +%s%N > ${shellPath}; sleep 0.5; done; echo LOOP-ENDED`;
};

function markerState(markerPath) {
  try {
    const stat = statSync(markerPath);
    return { exists: true, size: stat.size, mtimeMs: stat.mtimeMs, content: readFileSync(markerPath, "utf8").trim() };
  } catch {
    return { exists: false, size: 0, mtimeMs: 0, content: "" };
  }
}

export async function run({ evidenceDir }) {
  const bin = resolveOmpBin();
  const workspace = createProbeWorkspace("tv004");
  const rawLogPath = join(evidenceDir, "tv-004.jsonl");
  const controlLogPath = join(evidenceDir, "tv-004-control.jsonl");
  const project = workspace.project;
  const markerA = join(project, "sub-a.marker");
  const markerB = join(project, "sub-b.marker");
  const markerControl = join(project, "control.marker");

  const prompt = [
    "다음 작업을 순서대로 수행하라.",
    "1. task 도구로 하위 에이전트 두 개를 동시에 실행한다.",
    "2. 첫 번째 하위 에이전트에게는 정확히 이 bash 명령을 실행하게 하라:",
    `   ${markerLoop(markerA, 120)}`,
    "3. 두 번째 하위 에이전트에게는 정확히 이 bash 명령을 실행하게 하라:",
    `   ${markerLoop(markerB, 120)}`,
    "4. 두 하위 에이전트가 끝날 때까지 기다린다. 다른 도구는 쓰지 않는다.",
  ].join("\n");

  const result = {
    scenario: name,
    verificationId: "TV-004",
    ompBinary: bin,
    ompVersion: ompVersion(bin),
    promptModel,
    probeProject: project,
    prompt,
    criteria: [],
  };

  const args = baseArgs({ ...workspace, overlays: [], extra: [`--model=${promptModel}`] });
  const client = new OmpRpcClient({ bin, args, cwd: project, env: process.env, rawLogPath });
  const control = new OmpRpcClient({ bin, args: baseArgs({ ...workspace, overlays: [] }), cwd: project, env: process.env, rawLogPath: controlLogPath });

  try {
    await client.start();
    await client.send({ type: "set_subagent_subscription", level: "events" });

    // 대조군: 이 작업과 무관한 독립 엔진 프로세스가 계속 살아 있는지 확인하기 위한 표식 루프.
    await control.start();
    await control.send({ type: "bash", command: markerLoop(markerControl, 120) }, { timeoutMs: 4000 }).catch(() => undefined);

    await client.send({ type: "prompt", message: prompt }, { timeoutMs: 120000 });

    const lifecycleDeadline = Date.now() + 150000;
    let subagents = [];
    let nudged = false;
    while (Date.now() < lifecycleDeadline) {
      const snapshot = await client.send({ type: "get_subagents" });
      subagents = snapshot.data?.subagents ?? [];
      if (subagents.length >= 2) break;
      if (!nudged && Date.now() > lifecycleDeadline - 90000) {
        nudged = true;
        result.nudgeSent = true;
        await client.send({ type: "prompt", message: `지금 task 도구로 하위 에이전트 두 개를 실행하라. 첫 번째는 bash로 다음을 실행: ${markerLoop(markerA, 120)} / 두 번째는 bash로 다음을 실행: ${markerLoop(markerB, 120)}` }, { timeoutMs: 120000 }).catch(() => undefined);
      }
      await client.settle(2000);
    }
    result.subagentsObserved = subagents.map(({ id, index, agent, status, description, sessionFile, parentToolCallId }) => ({
      id,
      index,
      agent,
      status,
      description: description ?? null,
      sessionFile: sessionFile ?? null,
      parentToolCallId: parentToolCallId ?? null,
    }));
    result.criteria.push({
      id: "subagent-tree-visible",
      pass: subagents.length >= 2,
      detail: `관측 하위 에이전트 ${subagents.length}개: ${subagents.map((item) => `${item.id.slice(0, 8)}(${item.status})`).join(", ")}`,
    });

    // 하위 에이전트 메시지 구독: 바이트 커서 응답 확인.
    const firstSubagent = subagents[0];
    if (firstSubagent) {
      const messages = await client.send({ type: "get_subagent_messages", subagentId: firstSubagent.id }, { timeoutMs: 60000 });
      result.subagentMessages = {
        sessionFile: messages.data?.sessionFile ?? null,
        fromByte: messages.data?.fromByte ?? null,
        nextByte: messages.data?.nextByte ?? null,
        reset: messages.data?.reset ?? null,
        entries: (messages.data?.entries ?? []).length,
      };
      result.criteria.push({ id: "subagent-messages-paging", pass: messages.success === true && typeof messages.data?.nextByte === "number", detail: JSON.stringify(result.subagentMessages) });
    }

    // 표식이 실제로 갱신되는지 확인한 뒤 중단한다. 하위 에이전트의 bash 시작을 최대 60초 기다린다.
    const runningDeadline = Date.now() + 60000;
    let bothRunning = false;
    let samples = [];
    while (Date.now() < runningDeadline) {
      const first = markerState(markerA);
      await client.settle(1500);
      const second = markerState(markerA);
      const third = markerState(markerB);
      await client.settle(1500);
      const fourth = markerState(markerB);
      bothRunning = second.mtimeMs > first.mtimeMs && fourth.mtimeMs > third.mtimeMs;
      samples.push({ a: second.mtimeMs, b: fourth.mtimeMs });
      if (bothRunning) break;
    }
    result.descendantStartupWait = { bothRunning, samples: samples.slice(-4) };
    result.criteria.push({
      id: "descendant-work-running",
      pass: bothRunning,
      detail: `하위 에이전트 두 개의 표식이 모두 갱신됨=${bothRunning}`,
    });

    const abortAt = Date.now();
    await client.send({ type: "abort" });
    await client.waitForEvent((event) => event.type === "agent_end", { timeoutMs: 60000, description: "중단 후 agent_end" });

    // 중단 후 20초 동안 자손 프로세스가 계속 쓰는지 관측한다.
    const afterSamples = [];
    let aChanges = 0;
    let bChanges = 0;
    let lastA = markerState(markerA);
    let lastB = markerState(markerB);
    for (let index = 0; index < 10; index++) {
      await client.settle(2000);
      const nowA = markerState(markerA);
      const nowB = markerState(markerB);
      if (nowA.mtimeMs > lastA.mtimeMs) aChanges += 1;
      if (nowB.mtimeMs > lastB.mtimeMs) bChanges += 1;
      lastA = nowA;
      lastB = nowB;
      afterSamples.push({ at: Date.now() - abortAt, a: nowA.mtimeMs, b: nowB.mtimeMs, control: markerState(markerControl).mtimeMs });
    }
    result.afterAbortSampling = { aChanges, bChanges, samples: afterSamples };
    const subagentsAfter = (await client.send({ type: "get_subagents" })).data?.subagents ?? [];
    result.subagentsAfterAbort = subagentsAfter.map(({ id, status, description }) => ({ id, status, description: description ?? null }));

    result.criteria.push({
      id: "abort-tree-stopped",
      pass: aChanges === 0 && bChanges === 0,
      detail: `중단 후 20초 동안 표식 갱신 A=${aChanges}회, B=${bChanges}회, 하위 상태=${subagentsAfter.map((item) => item.status).join(", ")}`,
    });

    const controlAlive = afterSamples.at(-1).control > afterSamples[0].control;
    result.criteria.push({
      id: "other-work-preserved",
      pass: controlAlive,
      detail: `대조군 표식 갱신 ${afterSamples[0].control}→${afterSamples.at(-1).control}, 엔진 생존=${control.alive()}`,
    });

    const stateAfter = await client.send({ type: "get_state" });
    result.afterAbortStreaming = stateAfter.data?.isStreaming;
    result.criteria.push({ id: "main-not-streaming-after-abort", pass: stateAfter.data?.isStreaming === false, detail: `isStreaming=${String(stateAfter.data?.isStreaming)}` });

    result.eventTypes = [...new Set(client.eventTypes())];
    result.subagentEventTypes = result.eventTypes.filter((type) => String(type).startsWith("subagent"));
    result.toolEvents = client.events
      .filter((event) => String(event.type).startsWith("tool_execution"))
      .slice(0, 12)
      .map((event) => ({ type: event.type, toolName: event.toolName ?? null, isError: event.isError ?? null }));
    result.unparsedLines = client.unparsedLines.slice(0, 10);
    result.stderrTail = client.stderrText.slice(-1200);
  } finally {
    await client.stop();
    await control.stop();
  }

  result.rawLogPath = rawLogPath;
  result.controlLogPath = controlLogPath;
  result.pass = result.criteria.every((criterion) => criterion.pass);
  return result;
}
