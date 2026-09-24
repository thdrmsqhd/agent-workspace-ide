import { execFile } from "node:child_process";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { clearInterval, setInterval } from "node:timers";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * 앱 화면을 프레임으로 기록한다.
 * OS 화면 캡처가 아니라 CDP `Page.captureScreenshot`을 주기적으로 호출하므로 사용자 화면·포커스와 무관하다.
 * `Page.startScreencast`는 창이 화면에 보이지 않을 때 프레임을 내보내지 않아(실측 0프레임) 쓰지 않는다.
 */
export async function startRecording(cdp, { dir, quality = 70, intervalMs = 170, offsetMs = 0, startIndex = 0 } = {}) {
  if (!dir) throw new Error("프레임을 저장할 디렉터리(dir)가 필요합니다.");
  await mkdir(dir, { recursive: true });
  const frames = [];
  const started = Date.now();
  let index = startIndex;
  let stopped = false;
  let capturing = false;

  const capture = async () => {
    if (stopped || capturing) return;
    capturing = true;
    try {
      const shot = await cdp.send("Page.captureScreenshot", { format: "jpeg", quality, optimizeForSpeed: true }, { timeoutMs: 15_000 });
      const path = join(dir, `frame-${String(index++).padStart(5, "0")}.jpg`);
      await writeFile(path, Buffer.from(shot.data, "base64"));
      frames.push({ path, at: offsetMs + (Date.now() - started) });
    } catch {
      // 한 프레임 실패는 건너뛴다(녹화가 시험을 방해하지 않게).
    }
    capturing = false;
  };

  const timer = setInterval(() => { void capture(); }, intervalMs);
  await capture();

  return {
    frames,
    async stop() {
      stopped = true;
      clearInterval(timer);
      await new Promise((resolve) => setTimeout(resolve, 400));
      return { frameCount: frames.length, durationMs: Date.now() - started };
    },
  };
}

function ffmpegBinary() {
  return process.env.AWI_FFMPEG ?? "ffmpeg";
}

/**
 * ffmpeg 9의 drawtext는 Windows 드라이브 문자 콜론이 든 fontfile 경로를 파싱하지 못한다(실측).
 * 폰트를 작업 디렉터리로 복사해 상대 파일명으로 넘긴다.
 */
const CAPTION_FONT_FILE = "caption-font.ttf";
async function stageCaptionFont(workDir) {
  const source = process.env.AWI_CAPTION_FONT ?? "C:/Windows/Fonts/malgun.ttf";
  try {
    await copyFile(source, join(workDir, CAPTION_FONT_FILE));
    return true;
  } catch {
    return false;
  }
}

/** 프레임 도착 시각을 반영한 가변 프레임 영상으로 묶는다. captions가 있으면 단계 설명을 덧입힌다. */
export async function assembleMp4({ frames, outPath, fps = 15, width = 1280, captions = [] }) {
  if (frames.length === 0) throw new Error("녹화된 프레임이 없습니다.");
  const outAbs = resolve(outPath);
  const workDir = dirname(outAbs);
  await mkdir(workDir, { recursive: true });
  const listLines = [];
  for (let index = 0; index < frames.length; index++) {
    const current = frames[index];
    const next = frames[index + 1];
    const durationMs = next ? next.at - current.at : 1000 / fps;
    listLines.push(`file '${resolve(current.path).split("\\").join("/")}'`, `duration ${Math.max(0.02, durationMs / 1000).toFixed(3)}`);
  }
  // concat demuxer는 마지막 파일을 한 번 더 넣어야 마지막 duration이 반영된다.
  listLines.push(`file '${resolve(frames.at(-1).path).split("\\").join("/")}'`);
  const listPath = join(workDir, "frames.txt");
  await writeFile(listPath, `${listLines.join("\n")}\n`, "utf8");

  const baseArgs = ["-y", "-f", "concat", "-safe", "0", "-i", listPath];
  const tailArgs = ["-c:v", "libx264", "-preset", "medium", "-crf", "23", "-movflags", "+faststart", outAbs];
  const scale = `fps=${fps},scale=${width}:-2:flags=lanczos`;

  const fontDir = join(process.env.LOCALAPPDATA ?? workDir, "Temp", "awi-caption-font");
  await mkdir(fontDir, { recursive: true });
  const filter = (await stageCaptionFont(fontDir)) ? captionFilter(captions) : "";
  if (filter) {
    try {
      await run(ffmpegBinary(), [...baseArgs, "-vf", `${scale},${filter},format=yuv420p`, ...tailArgs], { cwd: fontDir, maxBuffer: 1024 * 1024 * 256 });
      return outPath;
    } catch {
      // 폰트·필터 문제로 실패하면 캡션 없이 다시 만든다.
    }
  }
  await run(ffmpegBinary(), [...baseArgs, "-vf", `${scale},format=yuv420p`, ...tailArgs], { cwd: fontDir, maxBuffer: 1024 * 1024 * 256 });
  return outPath;
}

function captionFilter(captions) {
  const sorted = [...captions].filter((item) => item?.text).sort((left, right) => left.atMs - right.atMs);
  if (sorted.length === 0) return "";
  const lastAt = sorted.at(-1).atMs;
  return sorted.map((item, index) => {
    const from = (item.atMs / 1000).toFixed(2);
    const to = (((sorted[index + 1]?.atMs ?? lastAt + 4000) - 200) / 1000).toFixed(2);
    if (from >= to) return "";
    return `drawtext=fontfile=${CAPTION_FONT_FILE}:text='${escapeText(item.text)}':x=24:y=h-64:fontsize=26:fontcolor=white:box=1:boxcolor=black@0.6:boxborderw=12:enable='between(t,${from},${to})'`;
  }).filter(Boolean).join(",");
}

function escapeText(text) {
  return text.replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/,/g, "\\,").replace(/'/g, "\u2019");
}
