import { test } from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readEditableFile, saveEditableFile } from "@awi/files";

test("미저장 초안은 외부 변경과 충돌 시 디스크를 덮지 않는다", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "awi-files-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, "code.txt");
  await writeFile(file, "원래\r\n\r\n");
  const opened = await readEditableFile(root, "code.txt");
  assert.equal(opened.eol, "crlf");
  const myDraft = "내 초안\r\n\r\n";
  await writeFile(file, "에이전트 변경\r\n");
  await assert.rejects(saveEditableFile(root, "code.txt", myDraft, opened.diskHash), (error) => error.code === "E_FILE_CONFLICT");
  assert.equal(await readFile(file, "utf8"), "에이전트 변경\r\n");
  const refreshed = await readEditableFile(root, "code.txt");
  const saved = await saveEditableFile(root, "code.txt", myDraft, refreshed.diskHash);
  assert.equal(saved.content, myDraft);
  assert.equal(saved.eol, "crlf");
  await assert.rejects(readEditableFile(root, "../outside"), /경계/);
});

test("새 파일은 부재 기대값에서만 만들고 잘못된 UTF-8을 텍스트로 열지 않는다", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "awi-files-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const saved = await saveEditableFile(root, "new.txt", "내용\n", null, true);
  assert.equal(saved.bom, true);
  assert.equal(saved.content, "내용\n");
  await assert.rejects(saveEditableFile(root, "new.txt", "덮기", null), (error) => error.code === "E_FILE_CONFLICT");
  await writeFile(join(root, "binary.dat"), Buffer.from([0xff, 0xfe]));
  await assert.rejects(readEditableFile(root, "binary.dat"), /encoded|encoding|UTF-8|valid/i);
});
