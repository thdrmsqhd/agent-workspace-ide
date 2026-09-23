# IMP-01 도구 버전과 기초 검증

2026-09-23. 기초 환경을 구성한 Linux 컨테이너에서 확인한 값이다. Windows, IDE 호스트, OMP 연동의 실행 결과가 아니다.

| 항목 | 현재 선택·측정 | 상태 |
| --- | --- | --- |
| Node.js | 24.19.0 | 개발 스캐폴드에 고정 (`.node-version`, `engines`) |
| npm | 11.9.0 | npm workspaces와 `package-lock.json`에 고정 |
| TypeScript | 5.9.3 | 계약 패키지 개발 의존성 |
| ESLint | 9.39.1 | 기초 정적 검사 개발 의존성 |
| Git | 2.51.1 | 현재 Linux 환경에서 확인 |
| SQLite | Node 24 내장 `node:sqlite` | Node API는 릴리스 후보 단계. 파일 DB 검사 완료, 최종 IDE 호스트에서 호환 확인 필요 |
| Theia IDE/확장 | 미선택 | TV-001/002, IMP-02에서 검증 후 고정 |
| OMP 런타임·RPC | 미선택 | TV-003/004/006, IMP-03에서 검증 후 고정 |
| Windows 11 x64 | 기초 CI만 통과 | 실제 디버거·PTY·확장 수용 검증 필요 |

이 문서는 실제 설치·검증 결과가 추가될 때 함께 갱신한다. `npm run build`는 계약과 영속성 없는 순수 코어 패키지만 컴파일하며 IDE 앱 실행을 뜻하지 않는다. `npm run dev`는 미구현 상태를 명확히 알리고 실패한다.

## 기초 검사 결과

2026-09-23 Linux 환경에서 `npm ci`, `npm run docs:check`(25개 문서, 50개 요구사항, 64개 시나리오), `npm run lint`, `npm run typecheck`, `npm run build`가 각각 종료 코드 0으로 통과했다. `npm run dev`는 예정대로 미구현 안내 후 종료 코드 1을 반환했다. 로컬 실행 결과는 계약 패키지의 컴파일과 문서 구조만 검증하며 실제 IDE/OMP, 제품 수용 시험이나 메모리 측정 결과가 아니다.

같은 날 [GitHub Actions 기초 CI](https://github.com/thdrmsqhd/agent-workspace-ide/actions/runs/35813477345)에서 Ubuntu와 Windows 작업 모두 `npm ci`·문서 검사·lint·typecheck·계약 build를 통과했다. 최초 Windows 실행은 문서 경로 구분자 차이로 실패했으며, 경로 정규화 후 재실행에 성공했다. Windows 작업의 성공은 **기초 스캐폴드 검사** 결과이며 데스크톱 앱·Java 디버거·Python 자동완성·OMP·메모리 목표 수용 결과는 아니다.

## 독립 규칙 구현 결과

2026-09-23 클린 설치 후 Linux에서 `npm run docs:check`, `npm run lint`, `npm run typecheck`, `npm run test:unit`을 실행하여 모두 통과했다. 단위 검사 6건은 CMD-06~10 입력, 대기열 수정·삭제 경쟁, Esc 중단과 대기열 정지, 불명 결과 재전송 방지, 12개 실행 슬롯을 다룬다. [새 코어 포함 GitHub Actions](https://github.com/thdrmsqhd/agent-workspace-ide/actions/runs/35815021871)에서도 Ubuntu·Windows 작업이 모두 통과했다. 이 검사는 순수 함수의 동작만 확인하며 DB 트랜잭션·실제 에이전트/IDE·동시 12개 프로세스 검증은 아니다.

## 첫 SQLite 저장 계층

2026-09-23 임시 파일 DB에서 메시지+operation+이벤트의 원자적 저장·재시작 복원, 기록 실패 시 롤백, FK, 전달 중 재시작 때 `unknown` 격리, 기존 미지원 스키마 보존, WAL 온라인 백업을 통합 검사했다. `node:sqlite` API는 현재 Node 24 문서에서 [릴리스 후보](https://nodejs.org/download/release/latest-v24.x/docs/api/sqlite.html)로 분류된다. 최종 IDE 호스트의 런타임과 Windows 파일 잠금, 디스크 부족, crash 직후 WAL 복구, 실제 에이전트 전달은 아직 확인하지 않았다. 코드와 테스트는 `packages/persistence`, `tests/integration`에 있다.

[SQLite 포함 기초 CI](https://github.com/thdrmsqhd/agent-workspace-ide/actions/runs/35816875908)의 Ubuntu·Windows 작업은 모두 통과했다. 최초 Windows 실행은 테스트가 DB 연결을 닫기 전에 임시 파일을 삭제하여 `EBUSY`가 발생했고, 연결 종료 후 삭제하도록 순서를 수정하여 재실행했다. 이 결과가 실제 제품의 디스크 부족·강제 종료 복구나 앱 연동을 증명하지는 않는다.
