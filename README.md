# Agent Workspace IDE

OMP 기반의 여러 프로젝트·워크트리 개발 작업을 한 화면에서 관리하는 독립 Windows IDE 프로젝트입니다.

**현재 상태: 제품·구현 문서, 기초 개발 환경, 공통 명령 봉투 및 순수 작업 큐 규칙을 준비했습니다. 데스크톱 앱은 아직 구현하지 않았습니다.**

- [문서 전체 색인](docs/00-document-index.md)
- [화면 명세](docs/04-screen-specification.md)
- [상황·버튼·액션별 시나리오](docs/04a-interaction-scenarios.md)
- [구현 작업과 의존성](docs/17-implementation-plan.md)
- [코딩 에이전트 지침](AGENTS.md)
- [도구 버전 및 검증 범위](docs/evidence/toolchain.md)

Node 24와 npm 11에서 `npm ci` 후 `npm run docs:check`, `npm run lint`, `npm run typecheck`, `npm run build`, `npm run test:unit`을 실행할 수 있습니다. 현재 빌드 대상은 `packages/contracts`의 공통 명령 봉투·CMD-06~10 입력 검증과 `packages/core`의 순수 대기열·중단·실행 슬롯 규칙입니다. DB 트랜잭션, IDE, OMP와 연결하지 않았으며 `npm run dev`는 명시적으로 실패합니다. IDE·OMP 실제 연동 검증은 [IMP-02/03](docs/17-implementation-plan.md)에 보류합니다.

상단 새 요청, 왼쪽 파일 트리, 가운데 작업 탭·대화·편집, 오른쪽 프로젝트·에이전트 세션 구조입니다. 목표는 최대 12개 메인 작업의 실제 동시 실행과 IDE 기능 유지, 현재 개발 구성 대비 메모리 절감입니다. 기반 기술과 성능은 검증 후 확정합니다.
