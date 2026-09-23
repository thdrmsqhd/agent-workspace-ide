# Agent Workspace IDE

OMP 기반의 여러 프로젝트·워크트리 개발 작업을 한 화면에서 관리하는 독립 Windows IDE 프로젝트입니다.

**현재 상태: 문서와 공통 계약, 큐·SQLite·Git 워크트리·Diff·파일 저장·화면 모듈을 구현 중입니다. 독립 Windows 앱은 아직 없습니다.**

- [문서 전체 색인](docs/00-document-index.md)
- [화면 명세](docs/04-screen-specification.md)
- [상황·버튼·액션별 시나리오](docs/04a-interaction-scenarios.md)
- [구현 작업과 의존성](docs/17-implementation-plan.md)
- [코딩 에이전트 지침](AGENTS.md)
- [도구 버전 및 검증 범위](docs/evidence/toolchain.md)
- [요구사항별 구현·보류 상태](docs/19-implementation-status.md)

Node 24와 npm 11에서 `npm ci` 후 `npm run docs:check`, `npm run lint`, `npm run typecheck`, `npm run build`, `npm run test:unit`, `npm run test:integration`을 실행할 수 있습니다. 큐·SQLite 상태, 초안·보기 복원, 워크트리 준비·선택 변경 가져오기, 원본 줄을 보존하는 Diff, 해시 조건부 파일 저장, 호스트 주입형 화면을 구현했습니다. 실제 에이전트/IDE/확장/디버거와 연결하지 않았으며 `npm run dev`는 명시적으로 실패합니다. IDE·OMP 실제 연동 검증은 [IMP-02/03](docs/17-implementation-plan.md)에 보류합니다.

상단 새 요청, 왼쪽 파일 트리, 가운데 작업 탭·대화·편집, 오른쪽 프로젝트·에이전트 세션 구조입니다. 목표는 최대 12개 메인 작업의 실제 동시 실행과 IDE 기능 유지, 현재 개발 구성 대비 메모리 절감입니다. 기반 기술과 성능은 검증 후 확정합니다.
