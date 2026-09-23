# Agent Workspace IDE

OMP 기반의 여러 프로젝트·워크트리 개발 작업을 한 화면에서 관리하는 독립 Windows IDE 프로젝트입니다.

**현재 상태:** 요구사항 50개에 대응하는 도메인·영속성·OMP RPC·Git/worktree·프로세스·첨부·IDE 상태·UI·복구·성능 측정·Windows Electron 셸의 구현 경로를 구성했습니다. 다만 구현 완료와 수용 검증 완료는 구분합니다. Theia/Electron 실제 Windows 앱 패키징, TV-001의 Java/Python/디버거 전체 기능, TV-002 교차 워크트리, 실제 OMP fallback 재검증, 3/12개 성능 실측은 아직 수용 증거가 필요합니다.

- [문서 전체 색인](docs/00-document-index.md)
- [화면 명세](docs/04-screen-specification.md)
- [상황·버튼·액션별 시나리오](docs/04a-interaction-scenarios.md)
- [구현 작업과 의존성](docs/17-implementation-plan.md)
- [요구사항별 구현 상태](docs/19-implementation-status.md)
- [TV-001 IDE 검증](docs/evidence/TV-001/README.md)
- [TV-003 OMP RPC 검증](docs/evidence/TV-003/README.md)
- [TV-004 하위 트리·중단 검증](docs/evidence/TV-004/README.md)
- [TV-006 읽기 전용 강제 검증](docs/evidence/TV-006/README.md)

## 개발 검증

Node 24 / npm 11에서 다음 검증을 사용합니다.

```bash
npm ci
npm run docs:check
npm run lint
npm run typecheck
npm run test:unit
npm run test:integration
```

실제 OMP 검증은 인증된 로컬 OMP가 필요하므로 CI와 분리합니다.

```bash
npm run verify:omp:tv003
npm run verify:omp:tv004
npm run verify:omp:tv006
```

## Windows 데스크톱

제품 셸은 `apps/desktop`의 Theia 1.75.0 + Electron 타깃입니다.

```powershell
npm run desktop:install
npm run desktop:build
npm run dev
```

네이티브 모듈 빌드 도구가 없는 환경에서는 Windows 패키징을 PASS로 기록하지 않습니다.

## 검수·성능

`npm run acceptance:summary`는 AT-01~23 증거를 집계하며 증거 파일이 없으면 자동으로 `NOT_RUN` 처리합니다. `npm run perf:collect`은 baseline/candidate의 3개·12개 작업 메모리 측정 자료를 생성합니다. `npm run reuse:evaluate`는 REQ-048의 80% 재사용 기준을 계산하되 미측정 항목을 만점으로 취급하지 않습니다.
