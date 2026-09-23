// 검증 호스트 빌드 보조: 네이티브 컴파일이 필요한 모듈을 스텁으로 대체한다.
// 이 PC에 Visual Studio 빌드 도구가 없어도 번들이 만들어지게 하기 위한 것이며,
// 프록시 CA 목록만 비게 된다. 제품 코드가 아니라 검증 호스트 전용이다.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";

const hostRoot = process.argv[2] ?? join(import.meta.dirname, "..", "..", "..", "apps", "ide-verification-host");
const caCertsDir = join(hostRoot, "node_modules", "@vscode", "windows-ca-certs");

const stubSource = [
  "// 검증 호스트 스텁: 실제 Crypt32 네이티브 애드온 대신 빈 인증서 목록을 돌려준다.",
  "class Crypt32 {",
  "  next() { return undefined; }",
  "  close() {}",
  "}",
  "const api = { Crypt32, default: { Crypt32 }, listCertificates: async () => [] };",
  "module.exports = api;",
  "module.exports.default = api;",
  "",
].join("\n");

const targets = [
  join(caCertsDir, "build", "Release", "crypt32.js"),
  join(caCertsDir, "index.js"),
  join(hostRoot, "stubs", "windows-ca-certs.cjs"),
];

for (const target of targets) {
  mkdirSync(join(target, ".."), { recursive: true });
  writeFileSync(target, stubSource);
  process.stdout.write(`스텁 작성: ${target}\n`);
}

// esbuild는 확장자 없는 main 경로를 .node로 먼저 해석한다. 실제 애드온 대신 자리 파일을 둬서
// 번들이 만들어지게 한다(파일 로더가 그대로 복사하며, 이 경로는 프록시 CA 조회 때만 호출된다).
const placeholder = join(caCertsDir, "build", "Release", "crypt32.node");
mkdirSync(join(placeholder, ".."), { recursive: true });
writeFileSync(placeholder, "AWI verification-host placeholder: real Crypt32 addon is not built on this machine.\n");
process.stdout.write(`자리 파일 작성: ${placeholder}\n`);
