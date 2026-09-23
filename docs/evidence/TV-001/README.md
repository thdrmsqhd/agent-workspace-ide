# TV-001 후보 IDE 확장·언어 기능 검증 (진행 중)

2026-09-23. 판정: **진행 중(부분 통과)**. 후보 IDE(Theia 1.75.0) 호스트를 구성해 실제로 띄웠고 확장을 설치·활성화했으나, 편집기 언어 기능과 디버깅 항목은 아직 확인하지 않았다. 통과로 보고하지 않는다.

## 1. 실행 조건

| 항목 | 값 |
| --- | --- |
| 실행일 | 2026-09-23 (KST) |
| OS | Windows 11 10.0.26200 (x64) |
| 후보 IDE | Theia 1.75.0 (VS Code API 지원 범위 1.134.0, `DEFAULT_SUPPORTED_API_VERSION`) |
| 호스트 소스 | `apps/ide-verification-host` (검증 호스트. 제품 앱 아님) |
| 자동화 | CDP(원격 디버깅)로 헤드리스 Chrome만 조작. 사용자 포커스·커서 비침해 |
| 재현 명령 | `npm run verify:theia:tv001` (사전: 호스트 설치·빌드·확장 다운로드) |

## 2. 확인한 것

| 항목 | 결과 |
| --- | --- |
| 호스트 빌드 | 성공. esbuild로 브라우저·노드 번들 생성 |
| 백엔드 기동 | 성공. `http://127.0.0.1:3000` 프론트엔드 응답 200 |
| 확장 배포 | 6개 배포: redhat.java, vscjava.vscode-java-debug, ms-python.python, ms-python.vscode-python-envs, ms-python.debugpy, vscode-icons-team.vscode-icons |
| 확장 활성화 | redhat.java가 실행되어 원격 측정 동의 요청과 JDK 경고를 표시(JVM 언어 서버 구동 시도 확인) |
| 워크벤치 화면 | 앱 셸·메뉴·상태 표시줄 렌더 확인, 스크린샷 기록 |
| 콘솔 오류 | 브라우저 콘솔 오류 0건 |

## 3. 막힌 지점

| 항목 | 원인 |
| --- | --- |
| 데스크톱(Electron) 셸 | 이 PC에 Visual Studio 빌드 도구가 없어 `@theia/ffmpeg`·`drivelist`·`native-keymap`·`keytar` 네이티브 모듈을 컴파일할 수 없다. 현재는 browser 타깃 + 헤드리스 Chrome으로 검증한다 |
| 워크스페이스 신뢰 모드 | 신뢰 대화상자가 첫 실행에서 부정으로 기록되어 상태 표시줄이 제한 모드로 남았다. 설정 파일로 우회하려 했으나 사용자 설정 경로(`~/.theia`)가 적용되지 않아 재확인 필요 |
| Java 확장 | JDK 21이 필요하다고 경고한다. `JAVA_HOME`을 지정해 기동했으나 확장이 인식하지 못했다(`java.jdt.ls.java.home` 설정 필요 여부 확인 중) |
| 언어 기능 | 자동완성·선언 이동·오류 표시·이름 변경은 미확인 |
| 디버깅 | 중단점·변수 조회는 미확인 |

## 4. 다음 절차

1. 워크스페이스 신뢰 상태를 확실히 해제하거나 신뢰 폴더로 등록해 탐색기·편집기가 정상 동작하게 한다.
2. Java 확장이 JDK 21을 인식하도록 설정(`java.jdt.ls.java.home` 등)을 적용한다.
3. 편집기를 열어 자동완성·선언 이동·진단·이름 변경을 확인하고, 디버그 세션으로 중단점·지역 변수를 확인한다.
4. 검증 작업대의 워크트리 두 개(`worktree-a`, `worktree-b`)로 TV-002 교차 전환을 확인한다.

## 5. 증거

- 화면: `docs/evidence/TV-001/raw/workbench.png`
- 요약: `docs/evidence/TV-001/raw/tv-001-summary.json`
- 백엔드 로그(확장 배포 기록): `docs/evidence/TV-001/raw/backend.log`
- 하네스: `scripts/verification/theia-host/` (`run.mjs`, `tv-001.mjs`, `cdp.mjs`, `probe-workspace.mjs`)
- 연결 REQ-022, REQ-023 / ADR-001
