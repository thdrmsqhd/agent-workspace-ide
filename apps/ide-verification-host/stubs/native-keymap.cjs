// 검증 호스트 스텁: native-keymap은 네이티브 애드온이 필요하다.
// 키보드 레이아웃을 알 수 없으므로 빈 맵을 돌려준다(단축키 문자 매핑은 이 호스트에서 미검증).
const getKeyMap = () => ({});
const getCurrentKeyboardLayout = () => undefined;
const getCurrentKeyboardLanguage = () => undefined;

module.exports = { getKeyMap, getCurrentKeyboardLayout, getCurrentKeyboardLanguage };
module.exports.default = module.exports;
