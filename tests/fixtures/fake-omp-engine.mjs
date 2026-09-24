import { createInterface } from "node:readline";
import process from "node:process";
import { setInterval, setTimeout } from "node:timers";

const ignoreAbort = process.argv.includes("--ignore-abort");
let streaming = ignoreAbort;
const sessionFile = "fake-session.jsonl";
process.stdout.write(JSON.stringify({ type: "ready", protocolVersions: [1,2] }) + "\n");
const lines = createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY });
lines.on("line", (line) => {
  const command = JSON.parse(line);
  if (command.type === "abort" && !ignoreAbort) streaming = false;
  if (command.type === "prompt") streaming = true;
  if (command.type === "get_state") {
    process.stdout.write(JSON.stringify({ type: "response", id: command.id, success: true, data: { isStreaming: streaming, sessionFile } }) + "\n");
    return;
  }
  if (command.type === "switch_session") {
    process.stdout.write(JSON.stringify({ type: "response", id: command.id, success: true, data: { sessionFile: command.sessionPath } }) + "\n");
    return;
  }
  process.stdout.write(JSON.stringify({ type: "response", id: command.id, success: true, data: { accepted: true, agentInvoked: command.type === "prompt", received: command } }) + "\n");
  if (command.type === "prompt" && !ignoreAbort) {
    setTimeout(() => {
      streaming = false;
      process.stdout.write(JSON.stringify({ type: "agent_end", messages: [] }) + "\n");
    }, 30);
  }
});
setInterval(() => undefined, 1000);
