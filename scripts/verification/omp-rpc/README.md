# OMP RPC 검증 하네스

설치된 OMP 엔진에 stdio RPC로 붙어 실제 프레임을 관측하고 결과를 `docs/evidence/`에 남기는 검증용 스크립트 모음이다. 제품 코드가 아니며 `packages/` 의존성이 없다. Node 24와 로컬에서 인증된 OMP가 필요하다.

## 사용법

```bash
npm run verify:omp:tv003   # TV-003 연결·프레임·요청 ID
npm run verify:omp:tv004   # TV-004 하위 에이전트 트리·중단
npm run verify:omp:tv006   # TV-006 읽기 전용 강제
```

기본 엔진 경로는 `~/.bun/bin/omp.exe`다. 환경 변수 `AWI_OMP_BIN`으로 바꿀 수 있다. 프롬프트가 필요한 검증의 모델은 `AWI_PROMPT_MODEL`로 바꿀 수 있고 기본값은 `openai-codex/gpt-6-astra`다.

## 구성

- `client.mjs` — JSON Lines 기반 최소 RPC 클라이언트. 요청 id 결합, v2 청크 재조립과 순서·길이 검증, 원시 로그 기록
- `probe.mjs` — 격리 작업대 생성(임시 디렉터리 Git 프로젝트), `--config` 오버레이 작성, 실행 인자 조립
- `tv-003.mjs`, `tv-004.mjs`, `tv-006.mjs` — 판정 기준과 증거 수집
- `mcp-probe-server.mjs` — 쓰기 도구 하나를 가진 최소 MCP 서버(newline-delimited JSON-RPC)
- `trim-logs.mjs` — 커밋용 증거 로그 축약기. 초대형 줄의 페이로드만 요약한다
- `run.mjs` — 시나리오 실행기. 결과 요약을 `docs/evidence/<검증 ID>/raw/`에 쓴다

## 제약

- 작업대는 매 실행마다 새 임시 디렉터리를 만들고, 사용자 프로젝트·세션·전역 설정을 수정하지 않는다.
- 모델 호출이 있는 시험은 실제 사용량이 발생하므로 CI에 넣지 않는다. 개발 PC에서 사용자가 직접 실행한다.
- 엔진 프로세스는 시험 종료 시 프로세스 트리째 종료한다. 자손 프로세스가 남는 시험(TV-004)은 중단 경로를 확인하기 위한 것이다.
