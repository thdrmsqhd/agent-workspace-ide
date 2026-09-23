# Agent Workspace IDE

OMP 기반의 여러 프로젝트·워크트리 개발 작업을 한 화면에서 관리하는 독립 Windows IDE 프로젝트입니다.

**현재 상태: 문서와 기초 환경, 공통 계약·순수 큐 규칙, 첫 SQLite 저장 계층을 준비했습니다. 데스크톱 앱은 아직 구현하지 않았습니다.**

- [문서 전체 색인](docs/00-document-index.md)
- [화면 명세](docs/04-screen-specification.md)
- [상황·버튼·액션별 시나리오](docs/04a-interaction-scenarios.md)
- [구현 작업과 의존성](docs/17-implementation-plan.md)
- [코딩 에이전트 지침](AGENTS.md)
- [도구 버전 및 검증 범위](docs/evidence/toolchain.md)

Node 24와 npm 11에서 `npm ci` 후 `npm run docs:check`, `npm run lint`, `npm run typecheck`, `npm run build`, `npm run test:unit`, `npm run test:integration`을 실행할 수 있습니다. `packages/persistence`는 프로젝트·작업·대기 메시지·operation·이벤트의 SQLite 트랜잭션, 재시작 격리와 온라인 백업을 구현합니다. 워크트리 생성, 첨부·초안·나머지 스키마, IDE, OMP와 연결하지 않았으며 `npm run dev`는 명시적으로 실패합니다. IDE·OMP 실제 연동 검증은 [IMP-02/03](docs/17-implementation-plan.md)에 보류합니다.

상단 새 요청, 왼쪽 파일 트리, 가운데 작업 탭·대화·편집, 오른쪽 프로젝트·에이전트 세션 구조입니다. 목표는 최대 12개 메인 작업의 실제 동시 실행과 IDE 기능 유지, 현재 개발 구성 대비 메모리 절감입니다. 기반 기술과 성능은 검증 후 확정합니다.
