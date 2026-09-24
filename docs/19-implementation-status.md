# 19. 구현 상태와 수용 보류 목록

2026-09-24. [03 요구사항](03-requirements-traceability.md)의 REQ-001~050을 기준으로 코드 구현 범위와 실제 수용 검증을 분리한다. **구현 경로가 존재한다는 사실만으로 PASS로 표시하지 않는다.** 최종 수용은 [16 수용 검증](16-acceptance-tests.md)과 `npm run acceptance:summary`의 증거가 권위자다.

| REQ | 구현 상태 | 코드/근거 | 남은 수용 검증 |
| --- | --- | --- | --- |
| 001 | 구현 + CI 검증 | `apps/desktop` Theia/Electron 독립 셸, `desktop:build`, CI `desktop-windows` 설치본·포터블 생성 | 제품 셸에서 dashboard/runtime을 실제 구동하는 AT([패키징 기록](evidence/win-packaging/README.md)) |
| 002,003,009,011,049,050 | 구현 | `packages/ui` 대시보드·새 요청·카드·작업 탭·4영역 DOM | 실제 desktop host 화면 AT |
| 004 | 구현 + 엔진 검증 | discussion OMP overlay: read/glob/grep/todo, write/shell/MCP 차단 | 제품 desktop에서 동일 정책 재확인 |
| 005,006,045 | 구현 | SQLite discussion 보존, `WorkspaceRuntime.startTask`, baseRef, worktree | 실제 UI 시작 흐름 |
| 007 | 구현 제약 | 12-slot domain/runtime | 실제 OMP 3개·12개 동시 실행 및 자원 실측 |
| 008 | 구현 | OMP subagent subscription/tree/messages + UI agent tree | 실제 제품 UI 트리 동기화 |
| 010 | 구현 | extension_ui_request → SQLite → 빠른 응답 UI → extension_ui_response | 실제 OMP 질문 round-trip |
| 012,013 | 구현 | immediate/queued, steer, queued update/delete, 원자 DB | 실제 UI 경합·완료 경계 |
| 014,015 | 구현 | file/folder/image/code-selection attachment + 경계 검사 | 실제 파일 선택 UI/엔진 이미지 입력 |
| 016 | 구현 fallback | RPC abort → 작업별 engine/shell/build process tree 종료, 서버/디버거 보존 | 실제 OMP TV-004를 제품 adapter 경로로 재실행 |
| 017,019,020,021 | 구현 | session artifact/settings restore, resume, recovery plan, graceful shutdown | 강제 종료/재시작/desktop 종료 장애주입 |
| 018,024,025,026 | 상태 모델 구현 | task별 IDE/buffer/terminal/debugger state, sourceChanged, process roles | Theia 실제 언어/PTY/debug session과 결합 TV-002/AT |
| 022,023 | 후보 호스트 구현·부분 검증 | Theia 1.75, Java/Python/debug/icons Open VSX 고정 | TV-001 언어기능·debug 전체, Electron host |
| 027 | 구현 | dirty buffer conflict + hash 조건부 UTF-8 저장 | 실제 Theia dirty buffer/외부 rename-delete |
| 028 | 구현 | TCP port lease/collision + HTTP(S) external open | 실제 개발 서버 ready/url 등록 |
| 029,030 | 구현 | 기존 OMP session `switch_session`, 새 worktree, 선택 변경 import | 실제 OMP TV-007 |
| 031,032 | 구현 | manual/automatic policy, workflow instruction, 승인 gate, 테스트 강제 금지 | 실제 프로젝트 지침 TV-014 |
| 033,034 | 구현 + Git 통합시험 | repoKey 직렬화, HEAD 재확인, conflict 격리 | 다중 실제 remote 반영 |
| 035 | 구현 | cleanup blockers + git worktree remove, branch/history 보존 | 실제 dirty/debug/server 조합 |
| 036,037 | 구현 | linked follow-up plan, completed/cancelled/archive 보존 | UI 완료/취소 카드 수용 |
| 038 | 구현 | review artifact: 원요청·후속·요약·files·checks·URL·integration actions | 실제 diff/editor 검토 화면 |
| 039,040 | 구현 | 원본 줄/EOL 보존 diff, change blocks, spacer 0 | 실제 두 editor + 연결선/독립 scroll |
| 041 | 구현 | project defaults + immutable task snapshot + restart restore | desktop settings UI |
| 042 | 구현 | global extension registry, 실행 중 update 차단, desktop pinned extensions | 실제 확장 업데이트/rollback |
| 043 | 구현 | HTTP(S) 외부 브라우저 dispatch | 실제 server-ready 연동 |
| 044 | 구현 | ordered environment preparation, 실패 중단, 같은 단계 재시도 | 실제 프로젝트별 workflow 명령 |
| 046 | 측정 도구 구현 | Windows/Linux process sampler + 3/12 baseline/candidate 비교 | 실제 동일 Windows 장비 반복 실측 |
| 047 | 구현 | core/UI와 OMP raw 타입 분리, `EngineSessionFactory`, `packages/engine-omp` edge adapter | 두 번째 엔진은 후속이며 지원 완료 주장 안 함 |
| 048 | 평가 gate 구현 | `reuse:evaluate`, 미측정 가중치 배제 | 후보별 실제 근거 입력, 80% 결정 |
| 033~038 외 반영 | 구현 | local merge, push, provider-neutral PR, side-effect journal/recovery | 실제 GitHub/원격 공급자 E2E |

## 현재 차단/미검증

코드 구현 자체의 주요 공백은 줄였지만 다음은 외부 실행 증거가 필요하다.

1. 제품 셸에서 dashboard/runtime을 실제 구동하는 AT. 패키징 자체는 CI `desktop-windows` success(2026-09-24, run 35989238780)로 검증됐고, 권한 없는 환경에서는 MinGW 대체 빌드로 `theia build`·패키징·기동까지 확인했다([기록](evidence/win-packaging/README.md)).
2. TV-001의 Java/Python 자동완성·선언 이동·진단·rename·debug 변수 전체 검증과 TV-002.
3. OMP 18.2.5 raw abort 실패를 제품 process-tree fallback으로 감싼 TV-004 재검증, 기존 세션 이전 TV-007.
4. 실제 3개/12개 동시 작업 메모리 baseline/candidate 측정과 장시간 PERF.
5. AT-01~23 실제 증거 파일. `npm run test:acceptance`가 시나리오를 실행해 `docs/evidence/acceptance/AT-xx.json`을 쓴다. 현재 AT-01·AT-03·AT-20·AT-22·AT-23은 PASS, AT-21은 모델 계층만 통과해 `BLOCKED`(편집기 독립 스크롤 UI 미검증), 나머지 17건은 미실행이다.

## 완료 판정 규칙

- CI의 lint/typecheck/build/unit/integration 성공은 구현 회귀 검증이다.
- OMP/IDE/Windows/성능 같은 외부 조건은 해당 TV/AT/PERF 증거 없이는 PASS가 아니다.
- 재시작 시 side-effect가 `unknown`이면 자동 재실행하지 않고 확인 대기로 둔다.
- raw OMP의 `abortTreeVerified=false`는 제품 fallback이 추가되어도 실제 TV 재검증 전까지 그대로 유지한다.
