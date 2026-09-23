import { createHash, randomUUID } from "node:crypto";
import { open, readFile, realpath, rename, rm, lstat } from "node:fs/promises";
import { dirname, sep } from "node:path";
import { resolveWithin } from "@awi/worktrees";

export interface FileVersion {
  readonly relativePath: string;
  readonly content: string;
  readonly diskHash: string;
  readonly bom: boolean;
  readonly eol: "crlf" | "lf" | "mixed" | "none";
}

export class FileConflict extends Error {
  readonly code = "E_FILE_CONFLICT";
  constructor(public readonly diskHash: string | null) {
    super("파일이 외부에서 변경되었습니다. 현재 파일과 초안을 비교해 주세요.");
    this.name = "FileConflict";
  }
}

function hash(bytes: Uint8Array): string { return createHash("sha256").update(bytes).digest("hex"); }

async function safePath(root: string, relativePath: string): Promise<string> {
  const canonicalRoot = await realpath(root);
  const path = resolveWithin(canonicalRoot, relativePath);
  const parent = await realpath(dirname(path));
  if (parent !== canonicalRoot && !parent.startsWith(canonicalRoot + sep)) throw new Error("링크가 작업 폴더 밖을 가리킵니다.");
  const metadata = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (metadata && (!metadata.isFile() || metadata.isSymbolicLink())) throw new Error("일반 파일만 편집할 수 있습니다.");
  return path;
}

async function bytesOrMissing(path: string): Promise<Buffer | undefined> {
  try { return await readFile(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}

export async function readEditableFile(root: string, relativePath: string): Promise<FileVersion> {
  const path = await safePath(root, relativePath);
  const bytes = await readFile(path);
  const bom = bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]));
  const content = new TextDecoder("utf-8", { fatal: true }).decode(bom ? bytes.subarray(3) : bytes);
  const hasCrLf = content.includes("\r\n");
  const hasLf = content.replaceAll("\r\n", "").includes("\n");
  return { relativePath, content, diskHash: hash(bytes), bom, eol: hasCrLf && hasLf ? "mixed" : hasCrLf ? "crlf" : hasLf ? "lf" : "none" };
}

/** 파일 버전이 다르면 원래 초안은 호출자에 남기고 디스크를 덮지 않는다. */
export async function saveEditableFile(root: string, relativePath: string, content: string, expectedDiskHash: string | null, bom = false): Promise<FileVersion> {
  const path = await safePath(root, relativePath);
  const before = await bytesOrMissing(path);
  if ((before ? hash(before) : null) !== expectedDiskHash) throw new FileConflict(before ? hash(before) : null);
  const utf8 = Buffer.from(content, "utf8");
  const output = bom ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), utf8]) : utf8;
  const temp = `${path}.awi-${randomUUID()}.tmp`;
  const handle = await open(temp, "wx", before ? (await lstat(path)).mode : 0o600);
  try {
    await handle.writeFile(output);
    await handle.sync();
  } finally { await handle.close(); }
  try {
    const current = await bytesOrMissing(path);
    if ((current ? hash(current) : null) !== expectedDiskHash) throw new FileConflict(current ? hash(current) : null);
    await rename(temp, path);
    return readEditableFile(root, relativePath);
  } finally { await rm(temp, { force: true }); }
}
