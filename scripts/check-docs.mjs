import { readFile, readdir } from "node:fs/promises";
import { join, relative, resolve, dirname, sep } from "node:path";
import process from "node:process";

const root = resolve(import.meta.dirname, "..");
const expected = {
  REQ: 50, SCN: 64, ADR: 12, TV: 14, CMD: 33,
  AT: 23, IMP: 18, PERF: 7, SCR: 10, OPEN: 8,
};
const errors = [];
const documents = new Map();

async function collect(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "node_modules" && entry.name !== "dist") await collect(path);
    } else if (entry.isFile() && path.endsWith(".md")) {
      documents.set(relative(root, path).split(sep).join("/"), await readFile(path, "utf8"));
    }
  }
}

await collect(root);
const definitionSets = new Map(Object.keys(expected).map((name) => [name, new Set()]));

for (const [name, content] of documents) {
  if (/[\u3040-\u30ff]/u.test(content)) errors.push(`${name}: 일본어 가나 문자 혼입`);
  if ((content.match(/^\s*```/gm) ?? []).length % 2 !== 0) errors.push(`${name}: 코드 블록 닫힘 오류`);

  const lines = content.split(/\r?\n/);
  let expectedColumns;
  for (const [index, line] of lines.entries()) {
    if (!line.startsWith("|")) { expectedColumns = undefined; continue; }
    const columns = (line.match(/(?<!\\)\|/g) ?? []).length;
    if (expectedColumns !== undefined && columns !== expectedColumns) {
      errors.push(`${name}:${index + 1}: 표 열 수 불일치 (${columns}/${expectedColumns})`);
    }
    expectedColumns = columns;
    const found = /^\| (REQ|SCN|ADR|TV|CMD|AT|IMP|PERF|SCR|OPEN)-(\d{2,3})\b/u.exec(line);
    if (found) {
      const label = `${found[1]}-${found[2]}`;
      if (definitionSets.get(found[1]).has(label)) errors.push(`${name}:${index + 1}: 중복 정의 ${label}`);
      definitionSets.get(found[1]).add(label);
    }
  }

  for (const link of content.matchAll(/\]\(([^)]+)\)/g)) {
    const target = link[1].split("#")[0];
    if (!target || /^[a-z]+:\/\//iu.test(target) || target.startsWith("mailto:")) continue;
    const file = resolve(root, dirname(name), target);
    if (!file.startsWith(root + sep)) { errors.push(`${name}: 저장소 밖 링크 ${target}`); continue; }
    const relativeTarget = relative(root, file).split(sep).join("/");
    if (!documents.has(relativeTarget)) errors.push(`${name}: 없는 문서 링크 ${target}`);
  }
}

for (const [prefix, size] of Object.entries(expected)) {
  const actual = definitionSets.get(prefix);
  for (let number = 1; number <= size; number++) {
    const id = `${prefix}-${String(number).padStart(prefix === "REQ" || prefix === "SCN" ? 3 : 2, "0")}`;
    // 검증 문서의 일부 ID는 세 자리, 다른 ID는 두 자리로 관리한다.
    const alternate = `${prefix}-${String(number).padStart(3, "0")}`;
    if (!actual.has(id) && !actual.has(alternate)) errors.push(`정의 누락: ${alternate}`);
  }
  for (const id of actual) {
    if (Number(id.split("-")[1]) > size) errors.push(`범위 초과: ${id}`);
  }
}

const requirements = definitionSets.get("REQ");
const commands = definitionSets.get("CMD");
const acceptance = documents.get("docs/16-acceptance-tests.md") ?? "";
const covered = new Set();
for (const line of acceptance.split(/\r?\n/)) {
  if (!/^\| AT-\d+/u.test(line)) continue;
  const cells = line.split("|");
  for (const id of cells[2]?.match(/\d{3}/g) ?? []) covered.add(`REQ-${id}`);
}
for (const id of requirements) if (!covered.has(id)) errors.push(`${id}: 수용 시험 연결 없음`);
const scenarios = documents.get("docs/04a-interaction-scenarios.md") ?? "";
for (const match of scenarios.matchAll(/\bCMD-\d{2}\b/g)) {
  if (!commands.has(match[0])) errors.push(`${match[0]}: 미정의 명령 참조`);
}

if (errors.length) {
  for (const error of errors) process.stderr.write(`문서 검사 오류: ${error}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`문서 검사 통과: ${documents.size}개 문서, 요구사항 ${requirements.size}개, 시나리오 ${definitionSets.get("SCN").size}개\n`);
}
