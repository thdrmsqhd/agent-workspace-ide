# TV-001 후보 IDE 확장·언어 기능 검증 (1단계 통과)

2026-09-23. 판정: **1단계 통과 / 전체 진행 중**. 후보 IDE 호스트(Theia 1.75.0)를 구성해 확장을 설치·활성화하고 검증 작업대를 열어 탐색기까지 확인했다. 편집기 언어 기능(자동완성·선언 이동·진단·이름 변경)과 디버깅(중단점·변수)은 아직 확인하지 않았으므로 TV-001 전체를 통과로 표시하지 않는다.

## 1. 실행 조건

| 항목 | 값 |
| --- | --- |
| 실행일 | 2026-09-23 (KST) |
| OS | Windows 11 10.0.26200 (x64) |
| 후보 IDE | Theia 1.75.0, VS Code API 지원 범위 1.134.0(`DEFAULT_SUPPORTED_API_VERSION`) |
| 호스트 소스 | `apps/ide-verification-host` (검증 호스트. 제품 앱 아님) |
| 자동화 | CDP로 헤드리스 Chrome만 조작. 사용자 마우스·키보드·창 포커스 비침해 |
| 재현 명령 | `npm run verify:theia:tv001` (사전: 호스트 설치·빌드·확장 내려받기) |

## 2. 1단계 결과

| 확인 항목 | 결과 |
| --- | --- |
| 호스트 빌드 | 성공. esbuild로 브라우저·노드 번들 생성 |
| 백엔드 기동 | 성공. 시나리오마다 임시 포트로 띄우고 끝나면 정리 |
| 확장 배포 | 6종: redhat.java, vscjava.vscode-java-debug, ms-python.python, ms-python.vscode-python-envs, ms-python.debugpy, vscode-icons-team.vscode-icons |
| 확장 활성화 | 상태 표시줄에 `Java: Activating…`·`Activating vscode-icons` 표시, 아이콘 테마 활성화 알림 확인 |
| 검증 작업대 열기 | 창 제목이 검증 작업대 이름으로 바뀜 |
| 탐색기 항목 | `.theia`, `.vscode`, `git-project`, `java-project`, `python-project`, `worktree-a`, `worktree-b`, `icon.svg`, `probe.json` |
| 워크스페이스 신뢰 | 작업대 설정으로 신뢰 대화상자를 없애고 제한 모드 해제(제한 모드 표시 사라짐) |
| 브라우저 콘솔 오류 | 0건 |

## 3. 남은 항목

| 항목 | 상태 |
| --- | --- |
| Java 진단·자동완성·선언 이동·이름 변경 | 미확인. 확장은 활성화 단계까지 확인 |
| Python 자동완성·선언 이동(교차 모듈) | 미확인 |
| 중단점·변수 조회(Java 디버깅) | 미확인. JDK 21 설정(`java.jdt.ls.java.home`)은 작업대에 적용해 둠 |
| 데스크톱(Electron) 셸 | 환경 차단. 이 PC에 Visual Studio 빌드 도구가 없어 ffmpeg·drivelist·native-keymap·keytar 네이티브 모듈 컴파일 불가 |
| Pylance | 대체 불가. Open VSX에 없어 Python은 확장 포함 언어 서버 사용 |

## 4. 다음 절차

1. 탐색기에서 `java-project/src/main/java/demo/Greeter.java`를 열어 진단·자동완성·이름 변경을 확인한다.
2. `java-project`에서 디버그 세션을 시작해 중단점·지역 변수를 확인한다.
3. Python 프로젝트에서 교차 모듈 자동완성·선언 이동을 확인한다.
4. 워크트리 두 개에서 같은 상대 경로를 열고 20회 교차 전환해 TV-002를 확인한다.

## 5. 증거

- 화면(탐색기·확장 활성화 상태): `docs/evidence/TV-001/raw/workbench.png`
- 요약(항목별 통과 근거): `docs/evidence/TV-001/raw/tv-001-summary.json`
- 백엔드 로그(확장 배포 기록): `docs/evidence/TV-001/raw/backend.log`
- 하네스: `scripts/verification/theia-host/` (`run.mjs`, `tv-001.mjs`, `cdp.mjs`, `probe-workspace.mjs`, `diagnose.mjs`)
- 연결 REQ-022, REQ-023 / ADR-001
