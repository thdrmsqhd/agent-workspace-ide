import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { promisify } from "node:util";

const run = promisify(execFile);

/** AT 증거 파일은 docs/evidence/acceptance/AT-xx.json 한 곳에만 둔다(16 수용 검증 §4). */
export const EVIDENCE_ROOT = join("docs", "evidence", "acceptance");
const ALLOWED_STATUS = new Set(["PASS", "FAIL", "BLOCKED", "NOT_RUN"]);

/** 증거에 남길 빌드·환경 정보. 커밋을 모르면 unknown으로 남기고 통과로 넘기지 않는다. */
export async function environment() {
  const commit = await run("git", ["rev-parse", "--short", "HEAD"], { cwd: process.cwd() })
    .then((result) => result.stdout.trim(), () => "unknown");
  return {
    commit,
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    recordedAt: new Date().toISOString(),
  };
}

export async function saveArtifact(id, name, data) {
  const path = await artifactPath(id, name);
  await writeFile(path, typeof data === "string" ? data : `${JSON.stringify(data, null, 2)}\n`, "utf8");
  return path.split("\\").join("/");
}

/** 증거 디렉터리를 만들고 파일 경로만 돌려준다(스크린샷처럼 도구가 직접 쓰는 경우). */
export async function artifactPath(id, name) {
  const dir = join(EVIDENCE_ROOT, id);
  await mkdir(dir, { recursive: true });
  return join(dir, name);
}

export async function writeEvidence({
  id,
  status,
  detail,
  title,
  scenario,
  precondition = "",
  steps = [],
  expected = "",
  actual = "",
  artifacts = [],
}) {
  if (!ALLOWED_STATUS.has(status)) throw new Error(`${id} 상태가 허용 목록에 없습니다: ${status}`);
  await mkdir(EVIDENCE_ROOT, { recursive: true });
  const record = {
    id,
    status,
    detail,
    title,
    scenario,
    precondition,
    steps,
    expected,
    actual,
    artifacts,
    env: await environment(),
  };
  await writeFile(join(EVIDENCE_ROOT, `${id}.json`), `${JSON.stringify(record, null, 2)}\n`, "utf8");
  return record;
}

/** 단계 기록을 모아 두었다가 한 번에 남긴다. 녹화 캡션을 위해 경과 시각도 함께 기록한다. */
export function createStepLog() {
  const steps = [];
  const startedAt = Date.now();
  const push = (result, name, detail) => {
    const at = Date.now() - startedAt;
    steps.push({ name, detail, result, at });
    return at;
  };
  return {
    steps,
    ok(name, detail = "") {
      push("ok", name, detail);
    },
    note(name, detail = "") {
      push("note", name, detail);
    },
    /** 시연 영상 캡션용: 이 시점의 경과 ms를 돌려준다. */
    mark(name) {
      return push("mark", name, "");
    },
  };
}
