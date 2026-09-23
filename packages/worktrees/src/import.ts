import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { copyFile, lstat, mkdir, readFile, realpath, rm } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { promisify } from "node:util";
import { inspectRepository, resolveWithin } from "./index.js";

const exec = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  return (await exec("git", args, { cwd, encoding: "utf8", timeout: 30_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true })).stdout.trimEnd();
}

function hash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export interface ImportedFile {
  id: string;
  kind: "added" | "modified" | "deleted" | "renamed";
  oldPath?: string;
  newPath?: string;
  sourceHash?: string;
  sizeBytes?: number;
}

export interface ImportPreview {
  id: string;
  sourceRoot: string;
  sourceHead: string;
  sourceManifestHash: string;
  files: ImportedFile[];
}

async function safeExistingFile(root: string, name: string): Promise<string> {
  const path = resolveWithin(root, name);
  const actualRoot = await realpath(root);
  let current = actualRoot;
  for (const part of relative(actualRoot, path).split(sep)) {
    current = join(current, part);
    const metadata = await lstat(current);
    if (metadata.isSymbolicLink()) throw new Error(`링크 파일은 가져올 수 없습니다: ${name}`);
  }
  const actual = await realpath(path);
  if (!actual.startsWith(actualRoot + sep) || !(await lstat(actual)).isFile()) {
    throw new Error(`일반 파일만 가져올 수 있습니다: ${name}`);
  }
  return actual;
}

function pathFromStatus(code: string, path: string): { kind: ImportedFile["kind"]; oldPath?: string; newPath?: string } {
  if (code === "??" || code.includes("A")) return { kind: "added", newPath: path };
  if (code.includes("D")) return { kind: "deleted", oldPath: path };
  if (code.includes("M")) return { kind: "modified", oldPath: path, newPath: path };
  throw new Error(`지원하지 않는 Git 변경 상태: ${code} (${path})`);
}

/** 미추적·staged·unstaged 변경을 나열하며 ignored와 .git 내부는 제외한다. */
export async function previewChanges(sourcePath: string): Promise<ImportPreview> {
  const repo = await inspectRepository(sourcePath);
  const raw = await git(repo.repoPath, ["status", "--porcelain=v1", "-z", "-uall"]);
  const records = raw.split("\0");
  const files: ImportedFile[] = [];
  for (let index = 0; index < records.length; index++) {
    const record = records[index];
    if (!record) continue;
    const code = record.slice(0, 2);
    const path = record.slice(3);
    let descriptor: Omit<ImportedFile, "id">;
    if (code.includes("R") || code.includes("C")) {
      const previous = records[++index];
      if (!previous) throw new Error("Git 이름 변경 상태가 불완전합니다.");
      descriptor = { kind: "renamed", oldPath: previous, newPath: path };
    } else descriptor = pathFromStatus(code, path);
    if (descriptor.newPath) {
      const file = await safeExistingFile(repo.repoPath, descriptor.newPath);
      const bytes = await readFile(file);
      descriptor = { ...descriptor, sourceHash: hash(bytes), sizeBytes: bytes.length };
    }
    if (descriptor.oldPath) resolveWithin(repo.repoPath, descriptor.oldPath);
    const id = `${descriptor.kind}:${descriptor.oldPath ?? ""}:${descriptor.newPath ?? ""}`;
    files.push({ id, ...descriptor });
  }
  const sourceManifestHash = hash(Buffer.from(JSON.stringify({ head: repo.headCommit, files })));
  return { id: randomUUID(), sourceRoot: repo.repoPath, sourceHead: repo.headCommit, sourceManifestHash, files };
}

async function safeTarget(root: string, name: string): Promise<string> {
  const path = resolveWithin(root, name);
  const actualRoot = await realpath(root);
  const parts = relative(actualRoot, path).split(sep);
  let cursor = actualRoot;
  for (const part of parts.slice(0, -1)) {
    cursor = join(cursor, part);
    await mkdir(cursor, { recursive: true });
    if ((await lstat(cursor)).isSymbolicLink() || await realpath(cursor) !== cursor) {
      throw new Error(`대상 경로에 외부 링크가 있습니다: ${name}`);
    }
  }
  const existing = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (existing && !existing.isFile()) throw new Error(`대상 파일 형식이 올바르지 않습니다: ${name}`);
  return path;
}

/** 복사 직전 스냅샷을 재검증한다. 대상이 깨끗하지 않으면 부분 덮어쓰지 않는다. */
export async function applySelectedChanges(preview: ImportPreview, selectedIds: readonly string[], targetPath: string): Promise<void> {
  const fresh = await previewChanges(preview.sourceRoot);
  if (fresh.sourceHead !== preview.sourceHead || fresh.sourceManifestHash !== preview.sourceManifestHash) {
    throw new Error("원본 변경이 발생했습니다. 가져오기 미리보기를 다시 확인해 주세요.");
  }
  const selected = preview.files.filter((file) => selectedIds.includes(file.id));
  if (selected.length !== selectedIds.length || new Set(selectedIds).size !== selectedIds.length) throw new Error("선택한 파일이 미리보기에 없습니다.");
  const target = await inspectRepository(targetPath);
  const source = await inspectRepository(preview.sourceRoot);
  if (target.repoKey !== source.repoKey || target.headCommit !== preview.sourceHead ||
      (await git(target.repoPath, ["status", "--porcelain=v1", "-z", "-uall"])) !== "") {
    throw new Error("대상 워크트리가 다른 기준이거나 이미 변경되어 있습니다.");
  }
  // 모든 경로를 복사 전에 검사한다. Git/파일 작업은 단일 DB 트랜잭션이 아니므로 실패 시 보존하고 진단한다.
  for (const file of selected) {
    if (file.oldPath) await safeTarget(target.repoPath, file.oldPath);
    if (file.newPath) {
      await safeExistingFile(source.repoPath, file.newPath);
      await safeTarget(target.repoPath, file.newPath);
    }
  }
  for (const file of selected) {
    if (file.newPath) {
      const bytes = await readFile(await safeExistingFile(source.repoPath, file.newPath));
      if (hash(bytes) !== file.sourceHash) throw new Error("복사 도중 원본 파일이 변경되었습니다. 대상 내용을 확인해 주세요.");
      await copyFile(await safeExistingFile(source.repoPath, file.newPath), await safeTarget(target.repoPath, file.newPath));
    }
    if (file.oldPath && (file.kind === "deleted" || file.kind === "renamed")) {
      await rm(await safeTarget(target.repoPath, file.oldPath), { force: true });
    }
  }
  const after = await previewChanges(preview.sourceRoot);
  if (after.sourceManifestHash !== preview.sourceManifestHash) throw new Error("복사 중 원본 상태가 바뀌었습니다. 대상 작업을 확인해 주세요.");
  for (const file of selected) {
    if (file.newPath && hash(await readFile(await safeExistingFile(target.repoPath, file.newPath))) !== file.sourceHash) {
      throw new Error("가져온 파일의 검증에 실패했습니다. 대상 작업을 확인해 주세요.");
    }
  }
}
