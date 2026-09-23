export interface RealLine {
  readonly text: string;
  readonly eol: "\r\n" | "\n" | "\r" | "";
}

export interface ChangeBlock {
  readonly kind: "insert" | "delete" | "replace";
  /** 실제 0부터 시작하는 줄 번호. 빈 구간이면 위치 경계만 가리킨다. */
  readonly oldStart: number;
  readonly oldEnd: number;
  readonly newStart: number;
  readonly newEnd: number;
}

export interface DiffModel {
  readonly oldLines: readonly RealLine[];
  readonly newLines: readonly RealLine[];
  readonly blocks: readonly ChangeBlock[];
  /** 원본에 삽입한 정렬용 행은 항상 0개다. */
  readonly spacerCount: 0;
  readonly precision: "exact" | "coarse" | "too_large";
}

/** 끝 개행을 가짜 빈 줄로 만들지 않는다. 실제 빈 줄은 빈 text와 해당 eol로 남긴다. */
export function splitRealLines(content: string): RealLine[] {
  const result: RealLine[] = [];
  let start = 0;
  for (let at = 0; at < content.length; at++) {
    if (content[at] !== "\n" && content[at] !== "\r") continue;
    const eol = content[at] === "\r" && content[at + 1] === "\n" ? "\r\n" : content[at] as "\r" | "\n";
    result.push({ text: content.slice(start, at), eol });
    if (eol === "\r\n") at++;
    start = at + 1;
  }
  if (start < content.length) result.push({ text: content.slice(start), eol: "" });
  return result;
}

function equal(a: RealLine, b: RealLine): boolean {
  return a.text === b.text && a.eol === b.eol;
}

function block(oldStart: number, oldEnd: number, newStart: number, newEnd: number): ChangeBlock {
  return {
    kind: oldStart === oldEnd ? "insert" : newStart === newEnd ? "delete" : "replace",
    oldStart, oldEnd, newStart, newEnd,
  };
}

/** 두 파일의 실제 줄 배열을 전혀 수정하지 않고 변경 범위만 계산한다. */
export function compareText(oldContent: string, newContent: string): DiffModel {
  const oldLines = splitRealLines(oldContent);
  const newLines = splitRealLines(newContent);
  if (oldContent.length > 5 * 1024 * 1024 || newContent.length > 5 * 1024 * 1024 ||
      oldLines.length > 100_000 || newLines.length > 100_000) {
    return { oldLines, newLines, blocks: [], spacerCount: 0, precision: "too_large" };
  }
  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && equal(oldLines[prefix]!, newLines[prefix]!)) prefix++;
  let oldEnd = oldLines.length;
  let newEnd = newLines.length;
  while (oldEnd > prefix && newEnd > prefix && equal(oldLines[oldEnd - 1]!, newLines[newEnd - 1]!)) {
    oldEnd--;
    newEnd--;
  }
  const n = oldEnd - prefix;
  const m = newEnd - prefix;
  if (n === 0 && m === 0) return { oldLines, newLines, blocks: [], spacerCount: 0, precision: "exact" };
  if (n === 0 || m === 0) return { oldLines, newLines, blocks: [block(prefix, oldEnd, prefix, newEnd)], spacerCount: 0, precision: "exact" };
  // 큰 중간 구간은 정밀 LCS 대신 전체 교체 구간으로 보여 메모리를 제한한다.
  if (n * m > 2_000_000) {
    return { oldLines, newLines, blocks: [block(prefix, oldEnd, prefix, newEnd)], spacerCount: 0, precision: "coarse" };
  }
  const width = m + 1;
  const matrix = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      matrix[i * width + j] = equal(oldLines[prefix + i]!, newLines[prefix + j]!)
        ? 1 + matrix[(i + 1) * width + j + 1]!
        : Math.max(matrix[(i + 1) * width + j]!, matrix[i * width + j + 1]!);
    }
  }
  const blocks: ChangeBlock[] = [];
  let i = 0;
  let j = 0;
  let startOld = -1;
  let startNew = -1;
  const finish = () => {
    if (startOld >= 0) {
      blocks.push(block(prefix + startOld, prefix + i, prefix + startNew, prefix + j));
      startOld = -1;
    }
  };
  while (i < n || j < m) {
    if (i < n && j < m && equal(oldLines[prefix + i]!, newLines[prefix + j]!)) {
      finish(); i++; j++;
    } else {
      if (startOld < 0) { startOld = i; startNew = j; }
      if (i < n && (j === m || matrix[(i + 1) * width + j]! >= matrix[i * width + j + 1]!)) i++;
      else j++;
    }
  }
  finish();
  return { oldLines, newLines, blocks, spacerCount: 0, precision: "exact" };
}

/** 독립 스크롤 뷰에서 변경 블록을 선택할 때만 두 위치를 함께 반환한다. */
export function targetForBlock(model: DiffModel, index: number): { leftLine: number; rightLine: number } {
  const change = model.blocks[index];
  if (!change) throw new RangeError("변경 블록을 찾을 수 없습니다.");
  return { leftLine: change.oldStart, rightLine: change.newStart };
}
