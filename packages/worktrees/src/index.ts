import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execute("git", args, { cwd, encoding: "utf8", timeout: 30_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true });
  return stdout.trim();
}

export interface RepositoryInfo {
  repoPath: string;
  repoKey: string;
  headCommit: string;
  currentBranch?: string;
}

/** 공통 Git 디렉터리를 키로 써서 다른 worktree 경로의 중복 등록을 식별한다. */
export async function inspectRepository(path: string): Promise<RepositoryInfo> {
  const input = await realpath(path);
  const repoPath = await realpath(await git(input, ["rev-parse", "--show-toplevel"]));
  const common = await git(input, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  const repoKey = await realpath(common);
  const headCommit = await git(input, ["rev-parse", "--verify", "HEAD^{commit}"]);
  const currentBranch = await git(input, ["symbolic-ref", "--quiet", "--short", "HEAD"]).catch(() => undefined);
  return { repoPath, repoKey, headCommit, ...(currentBranch ? { currentBranch } : {}) };
}

export interface WorktreeRequest {
  repoPath: string;
  taskId: string;
  worktreeRoot: string;
  journalDirectory: string;
  baseRef: string;
}

export interface WorktreeJournal {
  taskId: string;
  repoKey: string;
  baseCommit: string;
  branchName: string;
  worktreePath: string;
  stage: "reserved" | "created" | "needs_review";
}

async function saveJournal(path: string, journal: WorktreeJournal): Promise<void> {
  const temp = `${path}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(journal), { flag: "wx", mode: 0o600 });
  await rename(temp, path);
}

/** 기존 폴더·브랜치를 재사용하거나 불확실한 실패를 자동 제거하지 않는다. */
export async function prepareWorktree(request: WorktreeRequest): Promise<WorktreeJournal> {
  if (!uuid.test(request.taskId)) throw new Error("작업 ID는 UUID여야 합니다.");
  if (!request.baseRef || request.baseRef.startsWith("-")) throw new Error("기준 ref가 올바르지 않습니다.");
  const repo = await inspectRepository(request.repoPath);
  const baseCommit = await git(repo.repoPath, ["rev-parse", "--verify", `${request.baseRef}^{commit}`]);
  if (!/^[0-9a-f]{40,64}$/i.test(baseCommit)) throw new Error("기준 커밋을 확인할 수 없습니다.");
  const branchName = `awi/task/${request.taskId}`;
  await git(repo.repoPath, ["check-ref-format", "--branch", branchName]);
  await mkdir(request.worktreeRoot, { recursive: true });
  const root = await realpath(request.worktreeRoot);
  const worktreePath = join(root, request.taskId);
  const journalDir = resolve(request.journalDirectory);
  await mkdir(journalDir, { recursive: true });
  const journalPath = join(journalDir, `${request.taskId}.json`);
  if (await stat(journalPath).then(() => true, () => false)) throw new Error("같은 작업 준비 기록이 이미 있습니다.");
  if (await stat(worktreePath).then(() => true, () => false)) throw new Error("작업 경로가 이미 존재합니다.");
  if (await git(repo.repoPath, ["show-ref", "--verify", "--quiet", `refs/heads/${branchName}`]).then(() => true, () => false)) {
    throw new Error("작업 브랜치가 이미 존재합니다.");
  }
  let journal: WorktreeJournal = { taskId: request.taskId, repoKey: repo.repoKey, baseCommit, branchName, worktreePath, stage: "reserved" };
  await saveJournal(journalPath, journal);
  try {
    await git(repo.repoPath, ["worktree", "add", "-b", branchName, "--", worktreePath, baseCommit]);
    if (await realpath(worktreePath) !== worktreePath ||
        (await inspectRepository(worktreePath)).repoKey !== repo.repoKey) {
      throw new Error("생성한 워크트리의 경로 또는 저장소가 예상과 다릅니다.");
    }
    journal = { ...journal, stage: "created" };
    await saveJournal(journalPath, journal);
    return journal;
  } catch (error) {
    await saveJournal(journalPath, { ...journal, stage: "needs_review" });
    throw error;
  }
}

export async function readWorktreeJournal(journalDirectory: string, taskId: string): Promise<WorktreeJournal> {
  if (!uuid.test(taskId)) throw new Error("작업 ID는 UUID여야 합니다.");
  const data = JSON.parse(await readFile(join(journalDirectory, `${taskId}.json`), "utf8")) as WorktreeJournal;
  if (data.taskId !== taskId || !isAbsolute(data.worktreePath) || !isAbsolute(data.repoKey) ||
      !["reserved", "created", "needs_review"].includes(data.stage)) {
    throw new Error("워크트리 준비 기록이 손상되었습니다.");
  }
  return data;
}

/** 준비된 워크트리 안의 상대 경로만 허용한다. 삭제·쓰기 명령도 같은 검증을 거친다. */
export function resolveWithin(worktreePath: string, relativePath: string): string {
  const root = resolve(worktreePath);
  const candidate = resolve(root, relativePath);
  if (!relativePath || isAbsolute(relativePath) || candidate === root || !candidate.startsWith(root + sep) ||
      relativePath.split(/[\\/]/u).includes(".git")) {
    throw new Error("작업 경계를 벗어난 경로입니다.");
  }
  return candidate;
}

/** 기존 파일과 symlink/junction은 실제 경로까지 확인한다. */
export async function resolveExistingWithin(worktreePath: string, relativePath: string): Promise<string> {
  const candidate = resolveWithin(worktreePath, relativePath);
  const root = await realpath(worktreePath);
  const actual = await realpath(candidate);
  if (!actual.startsWith(root + sep)) throw new Error("링크가 작업 경계를 벗어납니다.");
  return actual;
}
