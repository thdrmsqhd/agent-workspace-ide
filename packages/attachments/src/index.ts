import { createHash } from "node:crypto";
import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { extname, relative, sep } from "node:path";
import { resolveWithin } from "@awi/worktrees";

export type AttachmentKind = "file" | "folder" | "image" | "code-selection";

export interface AttachmentItem {
  readonly id: string;
  readonly kind: AttachmentKind;
  readonly relativePath: string;
  readonly size: number;
  readonly sha256?: string;
  readonly children?: readonly AttachmentItem[];
  readonly code?: {
    readonly startLine: number;
    readonly endLine: number;
    readonly content: string;
  };
}

export interface PromptImageContent {
  readonly type: "image";
  readonly data: string;
  readonly mimeType: string;
}

export interface PromptAttachmentPayload {
  readonly text: string;
  readonly images: readonly PromptImageContent[];
}

export class AttachmentError extends Error {
  constructor(public readonly code: "E_ATTACHMENT_UNSUPPORTED" | "E_ATTACHMENT_BOUNDARY" | "E_ATTACHMENT_IO", message: string) {
    super(message);
    this.name = "AttachmentError";
  }
}

const imageExtensions = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);

function idFor(kind: AttachmentKind, path: string, extra = ""): string {
  return createHash("sha256").update(`${kind}\0${path}\0${extra}`).digest("hex");
}

async function canonical(root: string, relativePath: string): Promise<string> {
  try {
    const rootPath = await realpath(root);
    const target = resolveWithin(rootPath, relativePath);
    const actual = await realpath(target);
    if (actual !== rootPath && !actual.startsWith(rootPath + sep)) {
      throw new AttachmentError("E_ATTACHMENT_BOUNDARY", "첨부 경로가 작업 폴더를 벗어납니다.");
    }
    return actual;
  } catch (error) {
    if (error instanceof AttachmentError) throw error;
    throw new AttachmentError("E_ATTACHMENT_IO", `첨부를 읽을 수 없습니다: ${relativePath}`);
  }
}

async function fileItem(root: string, relativePath: string, explicitImage: boolean): Promise<AttachmentItem> {
  const path = await canonical(root, relativePath);
  const meta = await lstat(path);
  if (!meta.isFile() || meta.isSymbolicLink()) throw new AttachmentError("E_ATTACHMENT_UNSUPPORTED", "일반 파일만 파일 첨부로 사용할 수 있습니다.");
  const extension = extname(relativePath).toLowerCase();
  if (explicitImage && !imageExtensions.has(extension)) {
    throw new AttachmentError("E_ATTACHMENT_UNSUPPORTED", `지원하지 않는 이미지 형식입니다: ${extension || "확장자 없음"}`);
  }
  const bytes = await readFile(path);
  const kind: AttachmentKind = explicitImage || imageExtensions.has(extension) ? "image" : "file";
  return {
    id: idFor(kind, relativePath, createHash("sha256").update(bytes).digest("hex")),
    kind,
    relativePath,
    size: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

async function folderItem(root: string, relativePath: string): Promise<AttachmentItem> {
  const path = await canonical(root, relativePath);
  const meta = await lstat(path);
  if (!meta.isDirectory() || meta.isSymbolicLink()) throw new AttachmentError("E_ATTACHMENT_UNSUPPORTED", "폴더 첨부에는 실제 디렉터리가 필요합니다.");
  const entries = await readdir(path, { withFileTypes: true });
  const children: AttachmentItem[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isSymbolicLink()) throw new AttachmentError("E_ATTACHMENT_BOUNDARY", `폴더 첨부에 링크가 포함되어 있습니다: ${entry.name}`);
    const childPath = relative(root, `${path}${sep}${entry.name}`).split(sep).join("/");
    if (entry.isDirectory()) children.push(await folderItem(root, childPath));
    else if (entry.isFile()) children.push(await fileItem(root, childPath, false));
  }
  const size = children.reduce((sum, child) => sum + child.size, 0);
  return { id: idFor("folder", relativePath, String(size)), kind: "folder", relativePath, size, children };
}

export async function createPathAttachment(root: string, relativePath: string, kind: "file" | "folder" | "image"): Promise<AttachmentItem> {
  if (!relativePath.trim()) throw new AttachmentError("E_ATTACHMENT_IO", "첨부 경로가 비어 있습니다.");
  if (kind === "folder") return folderItem(root, relativePath);
  return fileItem(root, relativePath, kind === "image");
}

export function createCodeSelectionAttachment(relativePath: string, startLine: number, endLine: number, content: string): AttachmentItem {
  if (!relativePath.trim() || !Number.isInteger(startLine) || !Number.isInteger(endLine) || startLine < 1 || endLine < startLine) {
    throw new AttachmentError("E_ATTACHMENT_IO", "코드 선택 범위가 올바르지 않습니다.");
  }
  const size = Buffer.byteLength(content, "utf8");
  return {
    id: idFor("code-selection", relativePath, `${startLine}:${endLine}:${content}`),
    kind: "code-selection",
    relativePath,
    size,
    code: { startLine, endLine, content },
  };
}


const imageMimeTypes = new Map<string, string>([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".webp", "image/webp"],
]);

function decodeText(bytes: Buffer, relativePath: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new AttachmentError("E_ATTACHMENT_UNSUPPORTED", `UTF-8 텍스트로 전달할 수 없는 파일입니다: ${relativePath}`);
  }
}

async function materializeItem(root: string, item: AttachmentItem, images: PromptImageContent[]): Promise<string> {
  if (item.kind === "image") {
    const extension = extname(item.relativePath).toLowerCase();
    const mimeType = imageMimeTypes.get(extension);
    if (!mimeType) throw new AttachmentError("E_ATTACHMENT_UNSUPPORTED", `지원하지 않는 이미지 형식입니다: ${extension || "확장자 없음"}`);
    const path = await canonical(root, item.relativePath);
    const bytes = await readFile(path);
    images.push({ type: "image", data: bytes.toString("base64"), mimeType });
    return [
      "[AWI image attachment]",
      `path: ${item.relativePath}`,
      `imageIndex: ${images.length}`,
      "[/AWI image attachment]",
    ].join("\n");
  }
  if (item.kind === "file") {
    const path = await canonical(root, item.relativePath);
    const bytes = await readFile(path);
    return [
      "[AWI file attachment]",
      `path: ${item.relativePath}`,
      "content:",
      decodeText(bytes, item.relativePath),
      "[/AWI file attachment]",
    ].join("\n");
  }
  if (item.kind === "folder") {
    const sections: string[] = [];
    for (const child of item.children ?? []) sections.push(await materializeItem(root, child, images));
    return [
      "[AWI folder attachment]",
      `path: ${item.relativePath}`,
      sections.join("\n\n"),
      "[/AWI folder attachment]",
    ].filter(Boolean).join("\n");
  }
  throw new AttachmentError("E_ATTACHMENT_UNSUPPORTED", "경로 첨부로 처리할 수 없는 첨부 형식입니다.");
}

export async function materializePathAttachment(
  root: string,
  relativePath: string,
  kind: "file" | "folder" | "image",
): Promise<PromptAttachmentPayload> {
  const item = await createPathAttachment(root, relativePath, kind);
  const images: PromptImageContent[] = [];
  const text = await materializeItem(root, item, images);
  return { text, images };
}
