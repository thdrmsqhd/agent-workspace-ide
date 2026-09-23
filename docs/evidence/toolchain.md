# IMP-01 도구 버전과 기초 검증

2026-09-23. 기초 환경을 구성한 Linux 컨테이너에서 확인한 값이다. Windows, IDE 호스트, OMP 연동의 실행 결과가 아니다.

| 항목 | 현재 선택·측정 | 상태 |
| --- | --- | --- |
| Node.js | 24.19.0 | 개발 스캐폴드에 고정 (`.node-version`, `engines`) |
| npm | 11.9.0 | npm workspaces와 `package-lock.json`에 고정 |
| TypeScript | 5.9.3 | 계약 패키지 개발 의존성 |
| ESLint | 9.39.1 | 기초 정적 검사 개발 의존성 |
| Git | 2.51.1 | 현재 Linux 환경에서 확인 |
| Theia IDE/확장 | 미선택 | TV-001/002, IMP-02에서 검증 후 고정 |
| OMP 런타임·RPC | 미선택 | TV-003/004/006, IMP-03에서 검증 후 고정 |
| Windows 11 x64 | 기초 CI만 통과 | 실제 디버거·PTY·확장 수용 검증 필요 |

이 문서는 실제 설치·검증 결과가 추가될 때 함께 갱신한다. `npm run build`는 계약과 영속성 없는 순수 코어 패키지만 컴파일하며 IDE 앱 실행을 뜻하지 않는다. `npm run dev`는 미구현 상태를 명확히 알리고 실패한다.

## 기초 검사 결과

2026-09-23 Linux 환경에서 `npm ci`, `npm run docs:check`(25개 문서, 50개 요구사항, 64개 시나리오), `npm run lint`, `npm run typecheck`, `npm run build`가 각각 종료 코드 0으로 통과했다. `npm run dev`는 예정대로 미구현 안내 후 종료 코드 1을 반환했다. 로컬 실행 결과는 계약 패키지의 컴파일과 문서 구조만 검증하며 실제 IDE/OMP, 제품 수용 시험이나 메모리 측정 결과가 아니다.

같은 날 [GitHub Actions 기초 CI](https://github.com/thdrmsqhd/agent-workspace-ide/actions/runs/35813477345)에서 Ubuntu와 Windows 작업 모두 `npm ci`·문서 검사·lint·typecheck·계약 build를 통과했다. 최초 Windows 실행은 문서 경로 구분자 차이로 실패했으며, 경로 정규화 후 재실행에 성공했다. Windows 작업의 성공은 **기초 스캐폴드 검사** 결과이며 데스크톱 앱·Java 디버거·Python 자동완성·OMP·메모리 목표 수용 결과는 아니다.

## 독립 규칙 구현 결과

2026-09-23 클린 설치 후 Linux에서 `npm run docs:check`, `npm run lint`, `npm run typecheck`, `npm run test:unit`을 실행하여 모두 통과했다. 단위 검사 6건은 CMD-06~10 입력, 대기열 수정·삭제 경쟁, Esc 중단과 대기열 정지, 불명 결과 재전송 방지, 12개 실행 슬롯을 다룬다. 이 검사는 순수 함수의 동작만 확인하며 DB 트랜잭션·실제 에이전트/IDE·동시 12개 프로세스 검증은 아니다. 새 코어 포함 CI 결과는 별도로 확인한다.
