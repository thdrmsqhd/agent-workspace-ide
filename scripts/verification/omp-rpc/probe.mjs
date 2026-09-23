// 검증용 격리 작업대와 OMP 오버레이 설정을 만든다. 사용자 전역 설정·실제 프로젝트는 건드리지 않는다.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

export function resolveOmpBin() {
  const override = process.env.AWI_OMP_BIN;
  if (override) return override;
  if (process.platform === "win32") return join(homedir(), ".bun", "bin", "omp.exe");
  return join(homedir(), ".bun", "bin", "omp");
}

export function ompVersion(bin) {
  try {
    return execFileSync(bin, ["--version"], { encoding: "utf8", windowsHide: true }).trim();
  } catch (error) {
    return `버전 확인 실패: ${error.message}`;
  }
}

export function createProbeWorkspace(name) {
  // 실행마다 새 디렉터리를 쓴다. 이전 실행의 엔진 프로세스가 남아 있어도 삭제 충돌이 나지 않는다.
  const stamp = new Date().toISOString().replace(/[:.]/gu, "-");
  const root = join(tmpdir(), `awi-omp-${name}-${stamp}`);
  const project = join(root, "probe-project");
  const sessions = join(root, "sessions");
  const evidence = join(root, "raw");
  for (const dir of [project, sessions, evidence]) mkdirSync(dir, { recursive: true });

  writeFileSync(join(project, "README.md"), "# 검증용 프로젝트\n\nOMP RPC 검증 작업대다. 실제 사용자 프로젝트가 아니다.\n");
  writeFileSync(join(project, "notes.txt"), "변경 금지 표식: ORIGINAL-CONTENT\n");
  writeFileSync(join(project, "src-notes.txt"), "읽기 전용 논의에서 검색 대상이 되는 문장이다. 표식: SEARCH-MARKER-7731\n");

  run(project, ["init", "-q", "-b", "main"]);
  run(project, ["config", "user.email", "verification@example.invalid"]);
  run(project, ["config", "user.name", "awi-verification"]);
  run(project, ["add", "-A"]);
  run(project, ["commit", "-q", "-m", "probe: initial"]);
  return { root, project, sessions, evidence };
}

function run(cwd, args) {
  execFileSync("git", args, { cwd, stdio: "ignore", windowsHide: true });
}

export function writeOverlay(path, body) {
  writeFileSync(path, body);
  return path;
}

/** 셸 명령에 넘길 경로를 MSYS 형식(/c/...)으로 바꾼다. Windows 경로를 그대로 넘기면 역슬래시가 이스케이프로 해석된다. */
export function posixPath(path) {
  return path.replace(/\\/gu, "/").replace(/^([A-Za-z]):/u, (_match, drive) => `/${drive.toLowerCase()}`);
}

export function readGitStatus(project) {
  return execFileSync("git", ["status", "--porcelain"], { cwd: project, encoding: "utf8", windowsHide: true }).trim();
}

export function baseArgs({ project, sessions, overlays, extra = [] }) {
  const args = ["--mode=rpc", `--cwd=${project}`, `--session-dir=${sessions}`, "--thinking=off", "--no-title"];
  for (const overlay of overlays) args.push(`--config=${overlay}`);
  return [...args, ...extra];
}
