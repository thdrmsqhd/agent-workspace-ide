import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { PortLeaseManager } from "@awi/ide-integration";

test("선점 포트는 충돌을 명시하고 동적 포트로 독립 서버를 예약한다", async (t) => {
  const occupied = createServer();
  await new Promise((resolve, reject) => {
    occupied.once("error", reject);
    occupied.listen({ host: "127.0.0.1", port: 0 }, resolve);
  });
  t.after(() => occupied.close());
  const address = occupied.address();
  const busy = address.port;
  const manager = new PortLeaseManager();
  t.after(() => Promise.all([manager.releaseTask("A"), manager.releaseTask("B")]));
  await assert.rejects(manager.reserve("A", "busy", busy), /EADDRINUSE|address already in use/i);
  const a = await manager.reserve("A", "web");
  const b = await manager.reserve("B", "web");
  assert.notEqual(a.port, b.port);
  assert.match(a.url, /^http:\/\/127\.0\.0\.1:/);
});
