import assert from "node:assert/strict";
import { compareText, splitRealLines, targetForBlock } from "@awi/diff";
import { createStepLog, saveArtifact, writeEvidence } from "../lib/harness.mjs";

const ID = "AT-21";
const TITLE = "diff 모델: 가짜 빈 행 0, 삽입·삭제·교체 연결, 실제 빈 줄·CRLF·긴 줄";
const PRECONDITION = "삽입·삭제·교체·실제 빈 줄·CRLF·긴 줄·대용량 텍스트 쌍.";
const EXPECTED = "가짜 빈 행 0, 변경 블록이 좌/우 위치를 함께 가리킴, 비교 기준이 명확함.";
const UI_NOTE = "편집기 두 개의 독립 스크롤과 연결선(REQ-039, REQ-040의 UI 부분)은 제품 셸 화면 검증이 필요해 이 실행에서는 미검증이다.";

export default {
  id: ID,
  title: TITLE,
  precondition: PRECONDITION,
  expected: EXPECTED,
  async run() {
    const log = createStepLog();
    const models = {};
    const keep = (name, model) => {
      models[name] = {
        blocks: model.blocks,
        precision: model.precision,
        spacerCount: model.spacerCount,
        oldLines: model.oldLines.length,
        newLines: model.newLines.length,
      };
      return model;
    };

    const insert = keep("insert", compareText("a\nb\n", "a\nX\nb\n"));
    assert.deepEqual(insert.blocks, [{ kind: "insert", oldStart: 1, oldEnd: 1, newStart: 1, newEnd: 2 }]);
    const remove = keep("delete", compareText("a\nX\nb\n", "a\nb\n"));
    assert.deepEqual(remove.blocks, [{ kind: "delete", oldStart: 1, oldEnd: 2, newStart: 1, newEnd: 1 }]);
    const replace = keep("replace", compareText("a\nb\nc\n", "a\nB\nc\n"));
    assert.deepEqual(replace.blocks, [{ kind: "replace", oldStart: 1, oldEnd: 2, newStart: 1, newEnd: 2 }]);
    log.ok("삽입·삭제·교체 블록 경계", `insert ${JSON.stringify(insert.blocks[0])} / delete 오른쪽 경계 ${remove.blocks[0].newStart} / replace 좌 ${replace.blocks[0].oldStart}-${replace.blocks[0].oldEnd}`);

    const blanks = splitRealLines("a\n\nb\n");
    assert.equal(blanks.length, 3, "실제 빈 줄은 실제 줄로 세야 한다");
    assert.deepEqual(blanks[1], { text: "", eol: "\n" });
    const addedBlank = keep("blank_insert", compareText("a\n\nb\n", "a\n\n\nb\n"));
    assert.deepEqual(addedBlank.blocks, [{ kind: "insert", oldStart: 2, oldEnd: 2, newStart: 2, newEnd: 3 }]);
    log.ok("실제 빈 줄 구분", "a\\n\\nb\\n = 3줄(둘째가 실제 빈 줄), 빈 줄 하나 추가는 insert 블록으로 잡힘");

    keep("trailing_newline", compareText("a\n", "a\n"));
    assert.equal(splitRealLines("a\n").length, 1, "끝 개행이 가짜 빈 줄을 만들면 안 된다");
    assert.deepEqual(splitRealLines("a\n")[0], { text: "a", eol: "\n" });
    assert.deepEqual(splitRealLines("a")[0], { text: "a", eol: "" });
    assert.equal(splitRealLines("").length, 0);
    log.ok("끝 개행", "a\\n = 1줄(eol \\n), a = 1줄(eol 없음), 빈 파일 = 0줄");

    const crlf = splitRealLines("a\r\nb\r\n");
    assert.deepEqual(crlf, [{ text: "a", eol: "\r\n" }, { text: "b", eol: "\r\n" }]);
    const eolChange = keep("crlf_to_lf", compareText("a\r\nb\r\n", "a\nb\n"));
    assert.deepEqual(eolChange.blocks, [{ kind: "replace", oldStart: 0, oldEnd: 2, newStart: 0, newEnd: 2 }]);
    log.ok("EOL 보존과 비교 기준", "CRLF는 \\r\\n으로 보존되고 CRLF→LF 변경은 줄 텍스트가 같아도 replace로 드러남");

    const longLine = `${"x".repeat(200_000)}\n`;
    const longModel = keep("long_line", compareText(longLine, `${longLine}y\n`));
    assert.deepEqual(longModel.blocks, [{ kind: "insert", oldStart: 1, oldEnd: 1, newStart: 1, newEnd: 2 }]);
    assert.equal(longModel.oldLines.length, 1, "20만 자 한 줄이 여러 줄로 쪼개지면 안 된다");
    log.ok("긴 줄", "20만 자 한 줄이 1줄로 유지되고 삽입 위치가 정확함");

    const tooMany = keep("too_many_lines", compareText("l\n".repeat(100_001), "l\n".repeat(100_002)));
    assert.equal(tooMany.precision, "too_large", "10만 줄 초과는 정밀 비교 대신 too_large로 표시해야 한다");
    assert.deepEqual(tooMany.blocks, []);
    const tooBig = keep("too_big", compareText("y".repeat(5 * 1024 * 1024 + 1), "z"));
    assert.equal(tooBig.precision, "too_large", "5MB 초과는 too_large로 표시해야 한다");
    log.ok("대용량 표기", "10만 줄 초과·5MB 초과 모두 precision=too_large로 명시(조용한 오답 없음)");

    for (const [name, model] of Object.entries(models)) {
      assert.equal(model.spacerCount, 0, `${name}: 원본에 정렬용 빈 행을 넣으면 안 된다`);
    }
    assert.deepEqual(targetForBlock(insert, 0), { leftLine: 1, rightLine: 1 });
    assert.throws(() => targetForBlock(insert, 5), RangeError);
    log.ok("블록 연결", `targetForBlock이 좌/우(${targetForBlock(insert, 0).leftLine}, ${targetForBlock(insert, 0).rightLine})를 함께 반환하고 없는 블록은 RangeError`);

    const artifacts = [
      await saveArtifact(ID, "diff-models.json", models),
      await saveArtifact(ID, "steps.txt", `${log.steps.map((step) => `${step.result}\t${step.name}\t${step.detail}`).join("\n")}\n`),
    ];
    const record = await writeEvidence({
      id: ID,
      status: "BLOCKED",
      title: TITLE,
      scenario: "scripts/acceptance/scenarios/at-21-diff.mjs",
      detail: `모델 계층 기준(가짜 빈 행 0·블록 연결·비교 기준·CRLF·긴 줄·too_large 표기)은 통과했다. ${UI_NOTE}`,
      precondition: PRECONDITION,
      expected: EXPECTED,
      steps: log.steps,
      actual: "모델 계층 7개 항목 PASS, 편집기 UI(독립 스크롤·연결선) 미검증",
      artifacts,
    });
    return { status: record.status, detail: record.detail };
  },
};
