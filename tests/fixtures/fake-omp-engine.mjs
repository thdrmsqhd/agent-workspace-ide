import { createInterface } from "node:readline";
import process from "node:process";

const ignoreAbort = process.argv.includes("--ignore-abort");
let streaming = true;
process.stdout.write(JSON.stringify({ type: "ready", protocolVersions: [1,2] }) + "\n");
const lines = createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY });
lines.on("line", (line) => {
  const command = JSON.parse(line);
  if (command.type === "abort" && !ignoreAbort) streaming = false;
  if (command.type === "get_state") {
    process.stdout.write(JSON.stringify({ type: "response", id: command.id, data: { isStreaming: streaming } }) + "\n");
    return;
  }
  process.stdout.write(JSON.stringify({ type: "response", id: command.id, data: { accepted: true } }) + "\n");
});
setInterval(() => undefined, 1000);
