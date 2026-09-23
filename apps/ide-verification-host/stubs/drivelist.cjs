// 검증 호스트 스텁: drivelist는 네이티브 애드온이 필요하다(이 PC에 빌드 도구 없음).
// 드라이브 목록을 빈 배열로 돌려준다. 파일 열기는 경로 지정으로 계속 쓸 수 있다.
const list = async () => [];

module.exports = { list };
module.exports.default = { list };
