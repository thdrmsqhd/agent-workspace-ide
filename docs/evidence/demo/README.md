# 사용 케이스 시연 영상

제품 패키지 앱(CI 산출물)을 **화면 밖·포커스 불가 창 + CDP**로 구동해 실제 UI 조작을 녹화한 것입니다.
앱은 `AWI_DATA_DIR`로 제품 데이터만 임시 폴더로 격리해 띄우므로 사용자의 실제 상태(`~/.agent-workspace-ide`)와 Theia 프로필은 바뀌지 않습니다.

| 파일 | 케이스 | 내용 |
| --- | --- | --- |
| `demo-right-panel.mp4` | 우측 채널 이용 | 우측 `프로젝트 · 세션` 영역에서 프로젝트를 선택 |
| `demo-chat-input.mp4` | 채팅 입력 이용 | `새 요청` 입력란에 요청 작성(전송은 아래 이유로 하지 않음) |

## 파일 트리 케이스: 아직 없음

좌측 `파일` 패널(`aside.awi-files`)은 **파일을 볼 작업이 있어야** 채워집니다(`fileContextTask()` → `files(taskId)`가 그 작업의 워크트리 또는 프로젝트 저장소를 읽음). 프로젝트만 등록한 상태에서는 `파일을 볼 작업을 선택하세요`만 표시됩니다.

그런데 UI에서 `새 요청`을 전송해 작업을 만들면 **렌더러가 응답을 멈추고 CDP 소켓이 닫힙니다**(2회 재현). 창을 `focusable:true`로 바꿔도 같아 오프스크린 창 때문이 아닙니다. 이 경로가 막혀 있어 파일 트리 영상은 아직 만들지 못했습니다.

우회 스크립트는 있습니다: `scripts/acceptance/demo-file-tree.mjs` — 제품 API(`StateStore.createProject`/`createDiscussion`)로 작업을 시드하고 `AWI_DATA_DIR`로 격리해 띄웁니다. 다만 그 경로에서도 대시보드가 시드한 작업을 그리지 않아 원인 추적이 더 필요합니다.

## 재현

```
export PATH="$HOME/AppData/Local/awi-tools/node-v24.19.0-win-x64:$PATH"
node scripts/acceptance/demo-cases.mjs        # 우측 채널·채팅 입력
node scripts/acceptance/demo-file-tree.mjs    # 파일 트리(현재 미완)
```

선행 조건: CI 산출물을 `%LOCALAPPDATA%\Temp\awi-ci-artifact`에 내려받고 asar를 풀어 창을 오프스크린으로 패치한 사본이 있어야 합니다(절차는 `packaged-electron-cdp-driving` 스킬 참고).
