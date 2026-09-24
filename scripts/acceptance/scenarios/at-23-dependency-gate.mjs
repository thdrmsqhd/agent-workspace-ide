import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { createStepLog, saveArtifact, writeEvidence } from "../lib/harness.mjs";

const run = promisify(execFile);
const ID = "AT-23";
const TITLE = "엔진 경계 의존성 검사와 재사용 후보 평가 게이트";
const PRECONDITION = "core·ui·contracts 소스를 정적 스캔하고, docs/evidence/reuse-evaluation.json을 합성 입력으로 바꿔 게이트 판정을 확인한다(원본은 그대로 복원).";
const EXPECTED = "OMP 원시 타입이 core/UI에 없고, 미측정 항목이 80% 근거로 둔갑하지 않는다.";
const EVAL_DOC = join("docs", "evidence", "reuse-evaluation.json");
const SCAN_ROOTS = [join("packages", "core", "src"), join("packages", "ui", "src"), join("packages", "contracts", "src")];
const FORBIDDEN = [
  { pattern: /@oh-my-pi/i, label: "@oh-my-pi" },
  { pattern: /engine-omp/i, label: "engine-omp" },
  { pattern: /agentInvoked/, label: "agentInvoked" },
  { pattern: /subagent/i, label: "subagent" },
  { pattern: /session_id/i, label: "session_id" },
  { pattern: /\bomp\b/i, label: "omp" },
];

async function sourceFiles(dir) {
  const found = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await sourceFiles(path)));
    else if (/\.(ts|tsx)$/.test(entry.name)) found.push(path);
  }
  return found;
}

async function evaluate() {
  const { stdout } = await run(process.execPath, ["scripts/reuse-evaluate.mjs"], { cwd: process.cwd() });
  return JSON.parse(stdout);
}

/** 목표 통과 가중치까지만 pass로 두고 나머지는 fail로 두어 게이트 경계를 만든다. */
function measuredCase(base, targetPassWeight) {
  let accumulated = 0;
  return {
    ...base,
    criteria: base.criteria.map((item) => {
      if (accumulated + item.weight <= targetPassWeight) {
        accumulated += item.weight;
        return { ...item, status: "pass" };
      }
      return { ...item, status: "fail" };
    }),
  };
}

/** 미측정 가중치가 절반 남은 상태에서 측정된 항목만 모두 통과시킨다. */
function partialCoverageCase(base) {
  const total = base.criteria.reduce((sum, item) => sum + item.weight, 0);
  let measured = 0;
  return {
    ...base,
    criteria: base.criteria.map((item) => {
      if (measured + item.weight <= total / 2) {
        measured += item.weight;
        return { ...item, status: "pass" };
      }
      return { ...item, status: "not_measured" };
    }),
  };
}

export default {
  id: ID,
  title: TITLE,
  precondition: PRECONDITION,
  expected: EXPECTED,
  async run() {
    const log = createStepLog();
    const hits = [];
    let scanned = 0;
    for (const root of SCAN_ROOTS) {
      const files = await sourceFiles(root);
      log.note("스캔 대상", `${root} (${files.length}개 파일)`);
      for (const file of files) {
        scanned += 1;
        const text = await readFile(file, "utf8");
        for (const rule of FORBIDDEN) {
          const match = rule.pattern.exec(text);
          if (match) hits.push({ file: file.split("\\").join("/"), pattern: rule.label, sample: match[0] });
        }
      }
    }
    assert.deepEqual(hits, [], `core/UI/contracts에 엔진 원시 참조가 남아 있다: ${JSON.stringify(hits.slice(0, 5))}`);
    log.ok("엔진 경계 정적 스캔", `${scanned}개 소스 파일, 금지 패턴 ${FORBIDDEN.length}종 0건`);

    const original = await readFile(EVAL_DOC, "utf8");
    const originalHash = createHash("sha256").update(original).digest("hex");
    const base = JSON.parse(original);
    const criteria = base.criteria.map((item) => ({ id: item.id, weight: item.weight, status: item.status }));
    const weightTotal = criteria.reduce((sum, item) => sum + item.weight, 0);
    log.note("평가 기준", `${criteria.length}개 기준, 가중치 합 ${weightTotal}`);

    const cases = [
      { name: "문서 원본", document: base, expected: "undetermined", why: "전부 not_measured면 결정을 보류해야 한다" },
      { name: "전부 측정·통과 85%", document: measuredCase(base, 85), expected: "reuse-candidate", why: "측정 완료 + 80% 이상" },
      { name: "전부 측정·통과 70%", document: measuredCase(base, 70), expected: "do-not-fork", why: "측정 완료 + 80% 미만" },
      { name: "일부만 측정·측정분 전부 통과", document: partialCoverageCase(base), expected: "undetermined", why: "미측정이 남으면 80%를 주장할 수 없다" },
    ];

    const gate = {};
    try {
      for (const item of cases) {
        await writeFile(EVAL_DOC, `${JSON.stringify(item.document, null, 2)}\n`, "utf8");
        const result = await evaluate();
        gate[item.name] = { ...result, expected: item.expected };
        assert.equal(result.decision, item.expected, `${item.name}: ${item.why}`);
        log.ok(`게이트 ${item.name}`, `검증 ${result.verifiedPercent.toFixed(1)}% / 측정 ${result.coveragePercent.toFixed(1)}% → ${result.decision}`);
      }
    } finally {
      await writeFile(EVAL_DOC, original, "utf8");
    }
    const restoredHash = createHash("sha256").update(await readFile(EVAL_DOC, "utf8")).digest("hex");
    assert.equal(restoredHash, originalHash, "평가 문서 원본이 복원되어야 한다");
    log.ok("평가 문서 복원", `sha256 ${originalHash.slice(0, 12)}… 일치`);

    const artifacts = [
      await saveArtifact(ID, "dependency-scan.json", { scannedFiles: scanned, forbidden: FORBIDDEN.map((rule) => rule.label), hits, criteria }),
      await saveArtifact(ID, "reuse-gate.json", gate),
      await saveArtifact(ID, "steps.txt", `${log.steps.map((step) => `${step.result}\t${step.name}\t${step.detail}`).join("\n")}\n`),
    ];
    const record = await writeEvidence({
      id: ID,
      status: "PASS",
      title: TITLE,
      scenario: "scripts/acceptance/scenarios/at-23-dependency-gate.mjs",
      detail: `core/ui/contracts ${scanned}개 파일에 엔진 원시 참조 0건, 평가 게이트 4개 경계(미측정 보류·85% 후보·70% 불가·부분 측정 보류) 확인, 평가 문서 원본 복원 확인.`,
      precondition: PRECONDITION,
      expected: EXPECTED,
      steps: log.steps,
      actual: cases.map((item) => `${item.name}→${gate[item.name].decision}`).join(" | "),
      artifacts,
    });
    return { status: record.status, detail: record.detail };
  },
};
