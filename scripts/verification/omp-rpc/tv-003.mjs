// TV-003: OMP RPC 연결·프레임·요청 ID·수락/완료 구분을 실제 18.2.5 엔진에서 확인한다.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Buffer } from "node:buffer";
import process from "node:process";
import { OmpRpcClient } from "./client.mjs";
import { baseArgs, createProbeWorkspace, ompVersion, readGitStatus, resolveOmpBin } from "./probe.mjs";

export const name = "tv-003";

const bashCommand = (bytes) => `node -e "process.stdout.write('B'.repeat(${bytes}))"`;

export async function run({ evidenceDir }) {
  const bin = resolveOmpBin();
  const workspace = createProbeWorkspace("tv003");
  const rawLogPath = join(evidenceDir, "tv-003.jsonl");
  const client = new OmpRpcClient({ bin, args: baseArgs({ ...workspace, overlays: [] }), cwd: workspace.project, env: process.env, rawLogPath });
  const result = {
    scenario: name,
    verificationId: "TV-003",
    ompBinary: bin,
    ompVersion: ompVersion(bin),
    probeProject: workspace.project,
    sessionDir: workspace.sessions,
    modelFlag: "없음 (사용자 기본 설정)",
    criteria: [],
  };

  try {
    const ready = await client.start();
    result.ready = ready;
    result.criteria.push({
      id: "handshake",
      pass: ready.type === "ready" && ready.protocolVersion === 1 && Array.isArray(ready.supportedProtocolVersions),
      detail: `protocolVersion=${ready.protocolVersion}, supported=${JSON.stringify(ready.supportedProtocolVersions)}, maxFrameBytes=${ready.maxFrameBytes}, maxReassembledFrameBytes=${ready.maxReassembledFrameBytes}`,
    });

    const negotiated = await client.send({ type: "negotiate_protocol", protocolVersion: 2 });
    result.criteria.push({
      id: "protocol-v2-negotiation",
      pass: negotiated.success === true && negotiated.data?.protocolVersion === 2,
      detail: JSON.stringify(negotiated.data ?? negotiated.error),
    });

    const state = await client.send({ type: "get_state" });
    result.toolSurface = (state.data?.dumpTools ?? []).map((tool) => tool.name);
    result.sessionId = state.data?.sessionId;
    result.model = state.data?.model ? `${state.data.model.provider}/${state.data.model.id}` : null;
    result.criteria.push({ id: "tool-surface", pass: result.toolSurface.length > 0, detail: `${result.toolSurface.length}개: ${result.toolSurface.join(", ")}` });

    // 두 명령 동시 전송: 응답은 id로 결합되어야 한다(순서 보장 없음).
    const first = client.send({ type: "get_state" });
    const second = client.send({ type: "get_session_stats" });
    const [firstResponse, secondResponse] = await Promise.all([first, second]);
    result.criteria.push({
      id: "concurrent-id-binding",
      pass: firstResponse.command === "get_state" && secondResponse.command === "get_session_stats" && firstResponse.id !== secondResponse.id,
      detail: `${firstResponse.id}/${firstResponse.command} + ${secondResponse.id}/${secondResponse.command}`,
    });

    const delayedStart = Date.now();
    const delayed = await client.send({ type: "bash", command: "sleep 3 && echo DELAYED-MARKER-4521" }, { timeoutMs: 30000 });
    const delayedMs = Date.now() - delayedStart;
    const delayedOutput = delayed.data?.output ?? "";
    result.criteria.push({
      id: "delayed-response",
      pass: delayedMs >= 2800 && delayedOutput.includes("DELAYED-MARKER-4521"),
      detail: `지연 ${delayedMs}ms, 표식=${delayedOutput.includes("DELAYED-MARKER-4521")}, id=${delayed.id}`,
    });

    // 실패 프레임: 미지 명령은 id 없는 오류 응답으로 돌아온다(엔진 소스의 default 분기).
    await client.send({ type: "definitely_not_a_command" }, { timeoutMs: 4000 }).catch(() => undefined);
    await client.settle(500);
    const unknown = client.frames.find((frame) => frame.type === "response" && frame.command === "definitely_not_a_command") ?? null;
    // JSON이 아닌 줄: 파싱 실패는 id 없는 parse 오류 프레임이 된다.
    client.sendRaw("this is not json");
    await client.settle(1500);
    const parseError = client.frames.find((frame) => frame.type === "response" && frame.command === "parse");
    const afterFailure = await client.send({ type: "get_state" });
    result.failureFrames = { unknown, parseError: parseError ?? null };
    result.criteria.push({
      id: "failure-frame-shape",
      pass: unknown !== null && unknown.success === false && unknown.id === undefined && parseError !== undefined && parseError.success === false,
      detail: `미지 명령: id=${String(unknown?.id)} error="${unknown?.error}", 파싱 오류: ${parseError ? `id=${String(parseError.id)} error="${parseError.error}"` : "관측 안 됨"}`,
    });
    result.criteria.push({ id: "session-survives-failure", pass: afterFailure.success === true, detail: `실패 후 get_state 성공=${afterFailure.success}` });

    // 큰 출력: bash 도구 출력 상한을 실측한다.
    const ladder = [];
    for (const bytes of [1024, 102400, 5242880]) {
      const response = await client.send({ type: "bash", command: bashCommand(bytes) }, { timeoutMs: 120000 });
      ladder.push({ requestedBytes: bytes, returnedBytes: Buffer.byteLength(response.data?.output ?? "", "utf8"), success: response.success });
    }
    result.bashOutputLadder = ladder;
    result.criteria.push({
      id: "bash-output-cap",
      pass: ladder.every((entry) => entry.success === true),
      detail: ladder.map((entry) => `${entry.requestedBytes}→${entry.returnedBytes}B`).join(", "),
    });

    // 1MB를 넘는 stdin 명령과 그 응답: 프레임 한도 초과 시 chunk 재조립을 확인한다.
    const nameLength = 1200000;
    const oversized = await client.send({ type: "set_session_name", name: "N".repeat(nameLength) }, { timeoutMs: 60000 });
    const readBack = await client.send({ type: "get_state" }, { timeoutMs: 60000 });
    const chunks = client.chunkStats();
    result.oversizedCommand = {
      requestedNameLength: nameLength,
      response: { id: oversized.id, success: oversized.success, error: oversized.error ?? null },
      returnedNameLength: (readBack.data?.sessionName ?? "").length,
      chunks,
    };
    result.criteria.push({
      id: "oversized-command-1mb",
      pass:
        oversized.success === true &&
        (readBack.data?.sessionName ?? "").length === nameLength &&
        chunks.length > 0 &&
        chunks.every((entry) => entry.invalid === null && entry.complete === true),
      detail: `stdin ${nameLength}자 수락=${oversized.success}, 응답 세션명 ${(readBack.data?.sessionName ?? "").length}자, chunk ${chunks.length}건(완결 ${chunks.filter((entry) => entry.complete).length}건, 무효 ${chunks.filter((entry) => entry.invalid !== null).length}건)`,
    });

    const page = await client.send({ type: "get_messages_page", limit: 3 });
    result.historyPaging = { entries: (page.data?.entries ?? []).length, nextByte: page.data?.nextByte ?? null, reset: page.data?.reset ?? null };

    // 큰 이름이 이후 응답 크기에 영향을 주지 않도록 되돌린다.
    await client.send({ type: "set_session_name", name: "awi-verification" }, { timeoutMs: 30000 });

    // 수락과 완료의 구분: prompt 응답은 수락이고 agent_end가 완료 경계다.
    const promptStart = Date.now();
    const prompt = await client.send(
      { type: "prompt", message: "도구를 쓰지 말고 정확히 다음 한 단어만 답하라: ACK-TEST-9" },
      { timeoutMs: 180000 },
    );
    const acceptedAt = Date.now();
    const end = await client.waitForEvent((event) => event.type === "agent_end", { timeoutMs: 180000, description: "agent_end" });
    const completedAt = Date.now();
    result.prompt = {
      acceptance: { id: prompt.id, success: prompt.success, data: prompt.data ?? null, latencyMs: acceptedAt - promptStart },
      completion: { eventType: end.type, isTerminal: end.isTerminal ?? null, latencyMs: completedAt - acceptedAt },
      eventTypes: [...new Set(client.eventTypes())],
    };
    result.criteria.push({
      id: "acceptance-vs-completion",
      pass: prompt.success === true && end.type === "agent_end" && end.isTerminal === true && acceptedAt - promptStart < 1000,
      detail: `수락 ${acceptedAt - promptStart}ms(응답에 agentInvoked 필드 없음=${prompt.data === undefined}), 완료 경계 agent_end(isTerminal=${String(end.isTerminal)}) ${completedAt - acceptedAt}ms`,
    });

    result.projectUnchanged = readGitStatus(workspace.project) === "";
    result.criteria.push({ id: "no-project-mutation", pass: result.projectUnchanged, detail: `git status ${result.projectUnchanged ? "깨끗함" : readGitStatus(workspace.project)}` });
    result.unparsedLines = client.unparsedLines.slice(0, 20);
    result.stderrTail = client.stderrText.slice(-1500);
    result.rawLogBytes = readFileSync(rawLogPath).length;
  } finally {
    await client.stop();
  }

  result.rawLogPath = rawLogPath;
  result.pass = result.criteria.every((criterion) => criterion.pass);
  return result;
}
