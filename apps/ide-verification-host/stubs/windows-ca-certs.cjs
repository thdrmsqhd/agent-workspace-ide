// 검증 호스트 스텁: 실제 Crypt32 네이티브 애드온 대신 빈 인증서 목록을 돌려준다.
class Crypt32 {
  next() { return undefined; }
  close() {}
}
const api = { Crypt32, default: { Crypt32 }, listCertificates: async () => [] };
module.exports = api;
module.exports.default = api;
