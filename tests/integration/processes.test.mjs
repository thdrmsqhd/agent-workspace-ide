import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ProcessTreeSupervisor } from "@awi/processes";

const fixture = fileURLToPath(new URL("../fixtures/process-tree.mjs", import.meta.url));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function size(path) {
  try {
    return (await stat(path)).size;
  } catch (error) {
    if (error.code === "ENOENT") return 0;
    throw error;
  }
}

async function waitForHeartbeat(...paths) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const sizes = await Promise.all(paths.map(size));
    if (sizes.every((value) => value >= 3)) return;
    await sleep(50);
  }
  throw new Error("프로세스 트리 heartbeat가 시작되지 않았습니다.");
}

test("작업별 프로세스 트리 종료는 자손을 멈추고 다른 작업은 유지한다", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "awi-process-tree-"));
  const supervisor = new ProcessTreeSupervisor();
  t.after(async () => {
    await supervisor.stopAll({ graceMs: 300, forceWaitMs: 3_000 });
    await rm(directory, { recursive: true, force: true });
  });

  const aRoot = join(directory, "a-root.log");
  const aChild = join(directory, "a-child.log");
  const bRoot = join(directory, "b-root.log");
  const bChild = join(directory, "b-child.log");

  supervisor.start({
    ownerId: "task-a",
    role: "engine",
    executable: process.execPath,
    args: [fixture, aRoot, aChild],
  });
  supervisor.start({
    ownerId: "task-b",
    role: "engine",
    executable: process.execPath,
    args: [fixture, bRoot, bChild],
  });

  await waitForHeartbeat(aRoot, aChild, bRoot, bChild);
  assert.equal(supervisor.list("task-a").filter((item) => item.state === "running").length, 1);
  assert.equal(supervisor.list("task-b").filter((item) => item.state === "running").length, 1);

  const stopped = await supervisor.stopOwner("task-a", { graceMs: 500, forceWaitMs: 3_000 });
  assert.equal(stopped.length, 1);
  assert.equal(supervisor.list("task-a")[0].state, "exited");

  // 종료 직후 남아 있을 수 있는 마지막 동기식 append를 흘려보낸 다음 안정성을 본다.
  await sleep(150);
  const aRootStoppedAt = await size(aRoot);
  const aChildStoppedAt = await size(aChild);
  const bChildBefore = await size(bChild);
  await sleep(350);

  assert.equal(await size(aRoot), aRootStoppedAt, "중단된 작업의 루트 프로세스가 계속 실행 중");
  assert.equal(await size(aChild), aChildStoppedAt, "중단된 작업의 자손 프로세스가 계속 실행 중");
  assert.ok((await size(bChild)) > bChildBefore, "다른 작업의 자손 프로세스까지 함께 종료됨");
});
