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

test("서버 URL은 실제 lease와 일치하는 로컬 주소만 등록한다", async (t) => {
  const { ServerRegistry }=await import("@awi/ide-integration");
  const manager=new PortLeaseManager();
  t.after(()=>manager.releaseTask("T"));
  const lease=await manager.reserve("T","api");
  const registry=new ServerRegistry();
  const item=registry.register(lease,12345,lease.url);
  assert.equal(item.state,"running");
  assert.throws(()=>registry.register(lease,12345,"http://example.com:"+lease.port),/로컬/);
  assert.throws(()=>registry.register(lease,12345,"http://127.0.0.1:"+(lease.port+1)),/lease/);
  registry.markExited("T","api");
  assert.throws(()=>registry.open("T","api"),/실행 중/);
});
