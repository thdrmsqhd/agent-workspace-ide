import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCodeSelectionAttachment, createPathAttachment } from "@awi/attachments";

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
