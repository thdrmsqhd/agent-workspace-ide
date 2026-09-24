import { test } from "node:test";
import { Buffer } from "node:buffer";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { createCodeSelectionAttachment, createPathAttachment, materializePathAttachment } from "@awi/attachments";

test("파일·폴더·이미지·코드 범위를 작업 경계 안에서 첨부한다", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "awi-attach-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "docs"));
  await writeFile(join(root, "docs", "a.txt"), "A");
  await writeFile(join(root, "pic.png"), Buffer.from([1,2,3]));
  const folder = await createPathAttachment(root, "docs", "folder");
  assert.equal(folder.children.length, 1);
  const image = await createPathAttachment(root, "pic.png", "image");
  assert.equal(image.kind, "image");
  assert.throws(() => createCodeSelectionAttachment("src/a.ts", 5, 3, "x"), /범위/);
  const code = createCodeSelectionAttachment("src/a.ts", 2, 3, "const x = 1;");
  assert.deepEqual(code.code.startLine, 2);
  await assert.rejects(createPathAttachment(root, "../outside", "file"), /읽을 수|경계/);
  await assert.rejects(createPathAttachment(root, "docs/a.txt", "image"), /지원하지 않는 이미지/);
});


test("작업 루트가 링크 경로여도 자식 경로는 실제 루트 기준 상대 경로다", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "awi-attach-link-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const actual = join(base, "actual");
  const link = join(base, "link");
  await mkdir(actual);
  await mkdir(join(actual, "docs"));
  await writeFile(join(actual, "docs", "a.txt"), "alpha\n");
  // CI의 임시 경로 단축명(RUNNER~1)처럼 root 표기와 realpath 결과가 다르면,
  // 원본 root로 상대 경로를 만들면 상위 참조(..)가 섞인다.
  await symlink(actual, link, process.platform === "win32" ? "junction" : "dir");
  const payload = await materializePathAttachment(link, "docs", "folder");
  assert.match(payload.text, /path: docs\/a\.txt/);
  assert.match(payload.text, /alpha/);
  assert.doesNotMatch(payload.text, /\.\./u);
});

test("OMP 전달용 첨부는 텍스트 컨텍스트와 ImageContent로 실체화한다", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "awi-attach-prompt-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "docs"));
  await writeFile(join(root, "docs", "a.txt"), "alpha\nbeta\n");
  await writeFile(join(root, "docs", "pic.png"), Buffer.from([1, 2, 3, 4]));

  const payload = await materializePathAttachment(root, "docs", "folder");
  assert.match(payload.text, /path: docs\/a\.txt/);
  assert.match(payload.text, /alpha\nbeta/);
  assert.match(payload.text, /path: docs\/pic\.png/);
  assert.equal(payload.images.length, 1);
  assert.deepEqual(payload.images[0], {
    type: "image",
    data: Buffer.from([1, 2, 3, 4]).toString("base64"),
    mimeType: "image/png",
  });
});
