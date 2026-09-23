// TV-006 보조 도구: 쓰기 도구를 가진 최소 MCP 서버(newline-delimited JSON-RPC 2.0).
// 논의(읽기 전용) 모드에서 MCP 쓰기 도구가 노출되지 않는지 확인하는 데만 쓴다.
import { appendFileSync } from "node:fs";
import process from "node:process";

const markerPath = process.env.AWI_MCP_MARKER ?? "mcp-write.marker";
// 연결 확인용: 서버가 뜨면 시작 표식을 남긴다.
if (process.env.AWI_MCP_START) appendFileSync(process.env.AWI_MCP_START, `started ${Date.now()}\n`);
const tools = [
  {
    name: "write_probe_note",
    description: "검증용 표식 파일에 한 줄을 덧붙인다. 읽기 전용 논의 모드에서 차단되어야 하는 쓰기 도구다.",
    inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  },
];

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);

process.stdin.setEncoding("utf8");
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index = buffer.indexOf("\n");
  while (index !== -1) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line.length > 0) handle(line);
    index = buffer.indexOf("\n");
  }
});

function handle(line) {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: message.params?.protocolVersion ?? "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "awi-probe-mcp", version: "0.0.1" },
      },
    });
    return;
  }
  if (message.method === "notifications/initialized") return;
  if (message.method === "tools/list") {
    send({ jsonrpc: "2.0", id: message.id, result: { tools } });
    return;
  }
  if (message.method === "tools/call") {
    const text = String(message.params?.arguments?.text ?? "MCP-WRITE-EXECUTED");
    appendFileSync(markerPath, `${text}\n`);
    send({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: `기록됨: ${text}` }], isError: false } });
    return;
  }
  if (typeof message.id === "number" || typeof message.id === "string") {
    send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `Unknown method: ${message.method}` } });
  }
}
