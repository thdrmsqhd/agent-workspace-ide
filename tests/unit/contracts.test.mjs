import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCommandEnvelope, parseQueueCommand } from "@awi/contracts";

const taskId = "11111111-1111-4111-8111-111111111111";
const requestId = "22222222-2222-4222-8222-222222222222";
const messageId = "33333333-3333-4333-8333-333333333333";

function command(method, payload, expectedRevision = 0) {
  return { apiVersion: 1, requestId, method, taskId, expectedRevision, payload };
}

test("큐 명령은 ID, revision, 입력 범위와 빈 지시를 검증한다", () => {
  assert.equal(parseQueueCommand(command("task.send", { text: "  ", attachmentIds: [messageId], delivery: "queued" })).method, "task.send");
  for (const input of [
    command("task.send", { text: " ", attachmentIds: [], delivery: "queued" }),
    command("task.send", { text: "작업", attachmentIds: [], delivery: "later" }),
    command("queue.delete", { messageId, unexpected: true }),
    command("queue.update", { messageId, text: "변경", attachmentIds: [] }, -1),
    { ...command("queue.delete", { messageId }), unknown: true },
    { ...command("queue.delete", { messageId }), requestId: "not-a-uuid" },
    { ...command("task.send", { text: "작업", attachmentIds: [], delivery: "queued" }), apiVersion: 2 },
  ]) {
    assert.throws(() => parseQueueCommand(input), (error) => error.code === "E_VALIDATION");
  }
});

test("봉투 검증을 개별 명령 payload 검증으로 오인하지 않는다", () => {
  assert.equal(parseCommandEnvelope(command("project.register", {})).method, "project.register");
  assert.throws(() => parseQueueCommand(command("project.register", {})), (error) => error.code === "E_VALIDATION");
});
