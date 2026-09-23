import { appendFileSync } from "node:fs";
import { spawn } from "node:child_process";
import process from "node:process";
import { setInterval } from "node:timers";

const [rootHeartbeat, childHeartbeat] = process.argv.slice(2);
if (!rootHeartbeat || !childHeartbeat) throw new Error("heartbeat 경로 2개가 필요합니다.");

const childScript = `
  const { appendFileSync } = require("node:fs");
  const file = process.argv[1];
  setInterval(() => appendFileSync(file, "c"), 40);
`;
spawn(process.execPath, ["-e", childScript, childHeartbeat], {
  stdio: "ignore",
  windowsHide: true,
});

setInterval(() => appendFileSync(rootHeartbeat, "r"), 40);
