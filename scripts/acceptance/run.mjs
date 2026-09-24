import { readdir } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { EVIDENCE_ROOT, writeEvidence } from "./lib/harness.mjs";

const args = process.argv.slice(2);
const requested = args.filter((value) => !value.startsWith("--"));
const runAll = args.includes("--all") || requested.length === 0;
const scenarioDir = join(import.meta.dirname, "scenarios");

const files = (await readdir(scenarioDir)).filter((file) => file.endsWith(".mjs")).sort();
const results = [];

for (const file of files) {
  const module = await import(pathToFileURL(join(scenarioDir, file)).href);
  const scenario = module.default;
  if (!scenario || typeof scenario.run !== "function") continue;
  if (!runAll && !requested.includes(scenario.id)) continue;
  const started = Date.now();
  try {
    const outcome = await scenario.run();
    results.push({ id: scenario.id, title: scenario.title, status: outcome.status, detail: outcome.detail, ms: Date.now() - started });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const stack = error instanceof Error ? (error.stack ?? message) : message;
    const record = await writeEvidence({
      id: scenario.id,
      status: "FAIL",
      title: scenario.title,
      scenario: file,
      detail: `단계 실패: ${message}`,
      precondition: scenario.precondition ?? "",
      expected: scenario.expected ?? "",
      actual: stack.split("\n").slice(0, 12).join("\n"),
    });
    results.push({ id: record.id, title: scenario.title, status: record.status, detail: record.detail, ms: Date.now() - started });
  }
}

for (const result of results) {
  process.stdout.write(`${result.status.padEnd(8)}${result.id}  ${result.title}  (${result.ms}ms)\n`);
  if (result.detail) process.stdout.write(`         ${result.detail}\n`);
}

const failed = results.filter((result) => result.status === "FAIL").length;
process.stdout.write(`\n증거: ${EVIDENCE_ROOT}  |  실행 ${results.length}건, FAIL ${failed}건\n`);
process.exitCode = failed > 0 ? 1 : 0;
