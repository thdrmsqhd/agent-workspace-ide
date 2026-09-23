// 검증 호스트 스텁: keytar는 네이티브 애드온이 필요하다.
// OS 자격 증명 저장소를 쓰지 않고 빈 값을 돌려준다(토큰 저장·자동 로그인은 이 호스트에서 미검증).
const getPassword = async () => null;
const setPassword = async () => undefined;
const deletePassword = async () => false;
const findCredentials = async () => [];
const findPassword = async () => null;

module.exports = { getPassword, setPassword, deletePassword, findCredentials, findPassword };
module.exports.default = module.exports;
