import { test } from "node:test";
import assert from "node:assert/strict";
import { GlobalExtensionRegistry } from "@awi/ide-integration";

test("확장은 프로젝트 공통이며 실행 작업 중 버전 교체를 거절한다",()=>{
 const registry=new GlobalExtensionRegistry();
 registry.install({id:"java",version:"1",source:"open-vsx"});
 assert.deepEqual(registry.forProject("A"),registry.forProject("B"));
 assert.throws(()=>registry.install({id:"java",version:"2",source:"open-vsx"},1),/실행 작업/);
 registry.install({id:"java",version:"2",source:"open-vsx"},0);
 assert.equal(registry.list()[0].version,"2");
});
