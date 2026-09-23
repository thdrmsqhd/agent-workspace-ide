import { test } from "node:test";
import assert from "node:assert/strict";
import { compareText, splitRealLines, targetForBlock } from "@awi/diff";

test("개행·실제 빈 줄을 보존하고 정렬용 빈 줄을 만들지 않는다", () => {
  const original = "첫 줄\r\n\r\n끝\r\n";
  const revised = "첫 줄\r\n\r\n추가\n끝\r\n";
  const model = compareText(original, revised);
  assert.equal(model.oldLines.map((line) => line.text + line.eol).join(""), original);
  assert.equal(model.newLines.map((line) => line.text + line.eol).join(""), revised);
  assert.equal(model.oldLines[1].text, "");
  assert.equal(model.oldLines.length, 3);
  assert.equal(model.newLines.length, 4);
  assert.equal(model.spacerCount, 0);
  assert.equal(model.precision, "exact");
  assert.deepEqual(model.blocks, [{ kind: "insert", oldStart: 2, oldEnd: 2, newStart: 2, newEnd: 3 }]);
  assert.deepEqual(targetForBlock(model, 0), { leftLine: 2, rightLine: 2 });
});

test("파일 전체 삭제·교체·빈 파일을 실제 경계로 연결한다", () => {
  assert.deepEqual(compareText("A\nB\n", "").blocks, [{ kind: "delete", oldStart: 0, oldEnd: 2, newStart: 0, newEnd: 0 }]);
  assert.deepEqual(compareText("", "새 파일\n").blocks, [{ kind: "insert", oldStart: 0, oldEnd: 0, newStart: 0, newEnd: 1 }]);
  assert.deepEqual(compareText("A\n변경 전\nZ", "A\n변경 후\nZ").blocks, [{ kind: "replace", oldStart: 1, oldEnd: 2, newStart: 1, newEnd: 2 }]);
  assert.deepEqual(splitRealLines(""), []);
  assert.deepEqual(compareText("같음", "같음").blocks, []);
});

test("큰 중간 구간은 정밀도 제한을 알려주되 내용을 삭제하지 않는다", () => {
  const original = "전\n".repeat(1500);
  const revised = "후\n".repeat(1500);
  const model = compareText(original, revised);
  assert.equal(model.precision, "coarse");
  assert.equal(model.oldLines.length, 1500);
  assert.equal(model.newLines.length, 1500);
  assert.equal(model.blocks[0].kind, "replace");
  assert.equal(model.spacerCount, 0);
});
