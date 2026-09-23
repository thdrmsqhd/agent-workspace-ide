// 증거 로그 축약기: 구조는 남기고 초대형 줄만 요약해 저장소 비대를 막는다.
// 사용법: node scripts/verification/omp-rpc/trim-logs.mjs <로그 파일...>
import { readFileSync, writeFileSync } from "node:fs";
import process from "node:process";

const MAX_LINE_BYTES = Number(process.env.AWI_TRIM_MAX ?? 8192);

for (const path of process.argv.slice(2)) {
  const lines = readFileSync(path, "utf8").split("\n");
  let trimmed = 0;
  const output = lines.map((line) => {
    if (line.length <= MAX_LINE_BYTES) return line;
    trimmed += 1;
    let record = null;
    try {
      record = JSON.parse(line);
    } catch {
      return JSON.stringify({ direction: "unparsed", trimmed: true, originalBytes: line.length });
    }
    const payload = { ...record, trimmed: true, originalBytes: line.length };
    if (record.direction === "stdout" || record.direction === "stdin") {
      try {
        const frame = JSON.parse(record.text);
        payload.text = JSON.stringify({
          type: frame.type,
          id: frame.id,
          command: frame.command,
          index: frame.index,
          count: frame.count,
          byteLength: frame.byteLength,
          chunkId: frame.chunkId,
          note: "초대형 줄 축약: 페이로드 생략. 원본은 하네스 재실행으로 재생성된다.",
        });
      } catch {
        payload.text = `${record.text.slice(0, 400)}…(축약)`;
      }
    }
    return JSON.stringify(payload);
  });
  writeFileSync(path, output.join("\n"));
  process.stdout.write(`${path}: 줄 ${lines.length}개 중 ${trimmed}개 축약\n`);
}
