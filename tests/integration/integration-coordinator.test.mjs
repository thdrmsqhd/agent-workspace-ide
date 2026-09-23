import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { RepositoryIntegrationCoordinator } from "@awi/integration";
import { inspectRepository } from "@awi/worktrees";

const exec = promisify(execFile);
async function git(cwd, args) { return (await exec("git", args, { cwd, encoding:"utf8" })).stdout.trim(); }

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "awi-integrate-"));
  t.after(() => rm(root, { recursive:true, force:true }));
  await git(root, ["init","-b","main"]);
  await git(root, ["config","user.name","Test"]);
  await git(root, ["config","user.email","test@example.invalid"]);
  await writeFile(join(root,"shared.txt"),"base\n");
  await git(root,["add","."]); await git(root,["commit","-m","base"]);
  const base = await git(root,["rev-parse","HEAD"]);
  await git(root,["checkout","-b","feature-a"]);
  await writeFile(join(root,"a.txt"),"A\n"); await git(root,["add","."]); await git(root,["commit","-m","A"]);
  await git(root,["checkout","main"]);
  return { root, base, repoKey:(await inspectRepository(root)).repoKey };
}

test("같은 저장소 반영은 직렬화되고 대상 HEAD가 바뀌면 stale로 거절한다", async (t) => {
  const { root, base, repoKey } = await fixture(t);
  const coordinator = new RepositoryIntegrationCoordinator();
  const policy = { mode:"automatic", policyHash:"p", allowedActions:new Set(["merge"]) };
  const first = await coordinator.integrate({
    taskId:"A",repoKey,integrationWorktreePath:root,sourceRef:"feature-a",targetRef:"main",
    expectedTargetHead:base,policy,commitMessage:"merge A"
  });
  assert.equal(first.state,"merged");
  const second = await coordinator.integrate({
    taskId:"B",repoKey,integrationWorktreePath:root,sourceRef:"feature-a",targetRef:"main",
    expectedTargetHead:base,policy,commitMessage:"merge B"
  });
  assert.equal(second.state,"stale");
});

test("충돌은 해당 반영만 conflicted로 남기고 자동 덮어쓰지 않는다", async (t) => {
  const { root, base, repoKey } = await fixture(t);
  await git(root,["checkout","-b","feature-conflict",base]);
  await writeFile(join(root,"shared.txt"),"feature\n"); await git(root,["add","."]); await git(root,["commit","-m","feature"]);
  await git(root,["checkout","main"]);
  await writeFile(join(root,"shared.txt"),"main\n"); await git(root,["add","."]); await git(root,["commit","-m","main"]);
  const head = await git(root,["rev-parse","HEAD"]);
  const coordinator = new RepositoryIntegrationCoordinator();
  const policy = { mode:"automatic", policyHash:"p", allowedActions:new Set(["merge"]) };
  const result = await coordinator.integrate({
    taskId:"C",repoKey,integrationWorktreePath:root,sourceRef:"feature-conflict",targetRef:"main",
    expectedTargetHead:head,policy,commitMessage:"merge conflict"
  });
  assert.equal(result.state,"conflicted");
  assert.deepEqual(result.files,["shared.txt"]);
  await git(root,["merge","--abort"]);
});
