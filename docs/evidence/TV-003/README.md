# TV-003 OMP RPC 연결·프레임·요청 ID 검증 결과

2026-09-23. 판정: **통과**. 실제 설치된 OMP 18.2.5 엔진에 stdio RPC로 연결해 확인했다. 모의 어댑터 결과가 아니다.

## 1. 실행 조건

| 항목 | 값 |
| --- | --- |
| 실행일 | 2026-09-23 (KST) |
| OS | Windows 11 10.0.26200 (x64) |
| 엔진 | `omp` 18.2.5 (`~/.bun/bin/omp.exe`, sha256 `d2af3f99…f1023f`) |
| 엔진 본체 | `dist/cli.js` sha256 `56acf224…743237` |
| 검증 하네스 | Node 24.19.0 (저장소 `engines` 고정 버전) |
| 모델 | `openai-codex/gpt-6-astra` (수락·완료 시험 1회) |
| 작업대 | 임시 디렉터리의 격리 Git 프로젝트. 사용자 프로젝트·세션 미사용 |
| 재현 명령 | `npm run verify:omp:tv003` |

## 2. 통과 기준과 실측

| 확인 항목 | 실측 결과 |
| --- | --- |
| 연결·프로토콜 광고 | `protocolVersion=1`, `supported=[1,2]`, `maxFrameBytes=1048576`, `maxReassembledFrameBytes=67108864` |
| v2 협상 | `negotiate_protocol` 응답 `{protocolVersion:2}` |
| 도구 표면 | 11개: read, bash, edit, eval, glob, grep, task, hub, todo, web_search, write |
| 두 명령 동시 전송 | 응답이 각 `id`에 결합됨. 순서 보장 없음 |
| 지연 응답 | `sleep 3` 명령 응답 3090ms, 표식 문자열 일치 |
| 실패 프레임 | 미지 명령·JSON 파싱 실패 모두 `success:false`이며 **`id`를 되돌려주지 않음** |
| 실패 후 세션 | 오류 이후에도 `get_state` 정상 응답 |
| 큰 출력 | `bash` 출력은 1024·102400·5242880바이트 요청 모두 768바이트로 절단되어 반환 |
| 1MB 초과 stdin | 120만 자 `set_session_name` 수락, 이후 `get_state` 응답이 v2 chunk로 분할 |
| chunk 재조립 | `rpc-1` 5조각, 선언 1,277,485바이트 = 수신 바이트, 순서 연속, base64 왕복 일치 |
| 수락과 완료 | 수락 응답 4ms, 완료 경계 `agent_end`(`isTerminal=true`) 2511ms |
| 프로젝트 변경 | 없음 (`git status` 깨끗함) |

## 3. 앱 구현에 필요한 계약 차이

- 실패 응답에는 `id`가 없다(엔진 소스의 `default` 분기와 파싱 오류 경로가 `undefined` id로 응답). 앱은 요청 id로만 오류를 결합하면 안 되고 자체 타임아웃·순서 기반 격리가 필요하다.
- 청크는 논리 프레임 전체를 256KiB 단위로 자른 조각이고, `data`는 조각 바이트의 독립 base64다. 문자열을 이어붙여 디코딩하면 패딩 때문에 깨진다. 조각별로 바이트로 되돌린 뒤 합쳐야 한다.
- `byteLength`는 조각 크기가 아니라 재조립 대상 논리 프레임 전체의 UTF-8 바이트 수다.
- 청크는 프로토콜 v2에서만 나온다. v1로 남으면 1MiB 초과 응답은 `success:false` 오류로 대체된다.
- `prompt` 응답은 수락만 뜻하며 완료는 `agent_end`(`isTerminal`)다. 이 버전에서 응답 본문에 `agentInvoked` 필드는 오지 않았다.
- `bash` 응답은 출력이 768바이트로 절단되므로 큰 결과를 셸 출력으로 받는 설계는 성립하지 않는다. 파일·아티팩트 경로로 우회해야 한다.

## 4. 증거

- 원시 프레임 로그: `docs/evidence/TV-003/raw/tv-003.jsonl` (stdin·stdout 각 줄을 시각과 함께 기록)
- 요약: `docs/evidence/TV-003/raw/tv-003-summary.json`
- 하네스: `scripts/verification/omp-rpc/tv-003.mjs`
- 연결 REQ-007, REQ-019 / ADR-003

커밋한 로그는 `scripts/verification/omp-rpc/trim-logs.mjs`로 초대형 줄(청크 페이로드 등)만 축약했다. 이벤트 순서와 판정 근거는 그대로 남아 있고, 전문은 하네스 재실행으로 다시 만들 수 있다.
