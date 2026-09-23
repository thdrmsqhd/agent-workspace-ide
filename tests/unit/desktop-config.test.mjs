import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("제품 데스크톱 구성은 독립 Electron 타깃과 고정 확장을 가진다",async()=>{
 const pkg=JSON.parse(await readFile("apps/desktop/package.json","utf8"));
 assert.equal(pkg.theia.target,"electron");
 assert.equal(pkg.dependencies["@theia/electron"],"1.75.0");
 assert.ok(pkg.theiaPlugins["redhat.java"]);
 assert.ok(pkg.theiaPlugins["ms-python.python"]);
 assert.ok(pkg.theiaPlugins["vscode-icons-team.vscode-icons"]);
});
