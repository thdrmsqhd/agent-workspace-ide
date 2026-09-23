import { test } from "node:test";
import assert from "node:assert/strict";
import { SettingsRegistry } from "@awi/settings";

test("프로젝트 기본 설정 변경은 기존 작업 스냅샷을 바꾸지 않는다", () => {
  const settings = new SettingsRegistry();
  assert.equal(settings.setProjectDefault("P", { engine: "omp", model: "m1", mode: "manual" }), 0);
  const task = settings.captureTask("T1", "P");
  assert.equal(settings.setProjectDefault("P", { engine: "omp", model: "m2", mode: "automatic" }, 0), 1);
  assert.equal(settings.taskSnapshot("T1").model, "m1");
  assert.equal(task.mode, "manual");
  assert.throws(() => settings.captureTask("T1", "P"), /조용히 변경/);
  assert.equal(settings.captureTask("T2", "P").model, "m2");
});
