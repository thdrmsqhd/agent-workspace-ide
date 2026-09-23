import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { inspectRepository, prepareWorktree, readWorktreeJournal, resolveExistingWithin, resolveWithin } from "@awi/worktrees";

const run = promisify(execFile);

test("서로 다른 작업은 분리된 Git 워크트리를 만들고 원본 편집을 보존한다", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "awi-git-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const repoPath = join(directory, "original");
  await mkdir(repoPath);
  await run("git", ["init", "-b", "main"], { cwd: repoPath });
  await run("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-m", "base"], { cwd: repoPath });
  await writeFile(join(repoPath, "local.txt"), "원본 미커밋 변경");
  const root = join(directory, "worktrees");
  const journalDirectory = join(directory, "journals");
  const a = randomUUID();
  const b = randomUUID();
  const one = await prepareWorktree({ repoPath, taskId: a, worktreeRoot: root, journalDirectory, baseRef: "main" });
  const two = await prepareWorktree({ repoPath, taskId: b, worktreeRoot: root, journalDirectory, baseRef: "main" });
  assert.notEqual(one.worktreePath, two.worktreePath);
  assert.equal(one.repoKey, two.repoKey);
  assert.equal((await inspectRepository(one.worktreePath)).repoKey, (await inspectRepository(repoPath)).repoKey);
  assert.equal(await readFile(join(repoPath, "local.txt"), "utf8"), "원본 미커밋 변경");
  assert.equal((await readWorktreeJournal(journalDirectory, a)).stage, "created");
  await assert.rejects(prepareWorktree({ repoPath, taskId: a, worktreeRoot: root, journalDirectory, baseRef: "main" }), /이미/);
  assert.throws(() => resolveWithin(one.worktreePath, "../original/local.txt"), /경계/);
  assert.throws(() => resolveWithin(one.worktreePath, ".git/config"), /경계/);
  await writeFile(join(one.worktreePath, "owned.txt"), "A만 변경");
  assert.equal(await resolveExistingWithin(one.worktreePath, "owned.txt"), join(one.worktreePath, "owned.txt"));
  try {
    await symlink(join(repoPath, "local.txt"), join(one.worktreePath, "escape.txt"));
    await assert.rejects(resolveExistingWithin(one.worktreePath, "escape.txt"), /링크/);
  } catch (error) {
    if (error.code !== "EPERM") throw error;
  }
});
