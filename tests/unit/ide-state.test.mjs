import { test } from "node:test";
import assert from "node:assert/strict";
import { TaskIdeRegistry } from "@awi/ide-integration";

test("작업 전환은 언어 서비스·dirty 버퍼·디버거 상태를 유지한다", () => {
  const ide = new TaskIdeRegistry();
  const a = ide.register("A", "/work/a");
  const b = ide.register("B", "/work/b");
  ide.openBuffer("A", { relativePath: "src/Main.java", diskHash: "h1", content: "class A {}", dirty: false, externalConflict: false, cursorLine: 1 });
  ide.updateDraft("A", "src/Main.java", "class A { int x; }", 1);
  ide.setDebuggers("A", [{ id: "dbg", state: "paused", location: "Main.java:1", variables: { x: "1" }, sourceChanged: false }]);
  ide.select("B");
  ide.select("A");
  assert.equal(ide.active().languageServiceId, a.languageServiceId);
  assert.notEqual(a.languageServiceId, b.languageServiceId);
  assert.equal(ide.active().buffers["src/Main.java"].dirty, true);
  assert.equal(ide.active().debuggers[0].state, "paused");
  ide.markExternalChange("A", "src/Main.java", "h2");
  assert.equal(ide.active().buffers["src/Main.java"].externalConflict, true);
  ide.markSourceChanged("A", "src/Main.java");
  assert.equal(ide.active().debuggers[0].sourceChanged, true);
});
