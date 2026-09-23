// Theia 후보 호스트 검증 실행기. 사용법: node scripts/verification/theia-host/run.mjs <시나리오>
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import process from "node:process";

const scenarioName = process.argv[2] ?? "tv-001";
const repoRoot = resolve(import.meta.dirname, "..", "..", "..");
const scenario = await import(`./${scenarioName}.mjs`);
const evidenceDir = resolve(process.argv[3] ?? join(repoRoot, "docs", "evidence", scenario.verificationId ?? scenarioName, "raw"));
mkdirSync(evidenceDir, { recursive: true });

const result = await scenario.run({ evidenceDir });
const summaryPath = join(evidenceDir, `${scenarioName}-summary.json`);
writeFileSync(summaryPath, `${JSON.stringify(result, null, 2)}\n`);

process.stdout.write(`시나리오: ${scenarioName}\n`);
for (const criterion of result.criteria) {
  process.stdout.write(`  [${criterion.pass ? "통과" : "실패"}] ${criterion.id}: ${criterion.detail}\n`);
}
process.stdout.write(`요약: ${result.pass ? "전체 통과" : "실패 항목 있음"}\n`);
process.stdout.write(`증거: ${summaryPath}\n`);
if (!result.pass) process.exitCode = 1;
