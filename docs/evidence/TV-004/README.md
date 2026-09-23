# TV-004 하위 에이전트 트리·중단 검증 결과

2026-09-23. 판정: **실패**. 자손 작업 생성과 상태 관측은 확인했으나, 중단(Esc 상당 `abort`)이 하위 에이전트와 그 셸 자손을 멈추지 않았다.

## 1. 실행 조건

| 항목 | 값 |
| --- | --- |
| 실행일 | 2026-09-23 (KST) |
| OS | Windows 11 10.0.26200 (x64) |
| 엔진 | `omp` 18.2.5 (`~/.bun/bin/omp.exe`) |
| 모델 | `openai-codex/gpt-6-astra` |
| 작업대 | 임시 디렉터리의 격리 Git 프로젝트. 하위 에이전트가 남기는 생존 표식 파일 2개와, 무관한 독립 엔진 프로세스의 대조 표식 1개 |
| 재현 명령 | `npm run verify:omp:tv004` |

## 2. 통과 항목

| 확인 항목 | 실측 결과 |
| --- | --- |
| 하위 트리 노출 | `get_subagents`에서 2개(MarkerLoopA, MarkerLoopB), 부모 도구 호출 ID 공유 |
| 하위 메시지 조회 | `get_subagent_messages` 응답 `fromByte=0`, `nextByte=29487`, `reset=false`, 항목 3개 |
| 자손 작업 실행 | 중단 전 두 표식 모두 갱신 확인 |
| 이벤트 종류 | `tool_execution_start`·`_update`·`_end`, `subagent_lifecycle`·`subagent_event`·`subagent_progress`, `agent_start`·`turn_start`·`message_*`·`turn_end`·`agent_end` |
| 무관 작업 유지 | 별도 엔진 프로세스의 표식이 시험 내내 계속 갱신, 프로세스 생존 |
| 메인 상태 | 중단 후 `get_state.isStreaming=false` |

## 3. 실패 항목

| 확인 항목 | 실측 결과 |
| --- | --- |
| 자손 중단 | `abort` 후 20초 동안 표식 갱신이 A 10회, B 10회 계속됨. `get_subagents` 상태도 `running` 유지 |

중단 후에도 하위 에이전트의 셸 루프가 계속 실행되었다. 이는 "미완료 작업을 완료로 표시하지 않는다"는 요구와 충돌하므로 중단 기능은 완료로 볼 수 없다.

## 4. 원인

설치 버전의 세션 중단 경로는 제목 생성·압축·재시도·자체 `bash`·`eval`·메인 에이전트를 취소하지만, `task` 도구가 만든 하위 에이전트 실행은 취소 대상에 포함되지 않는다(`src/session/agent-session.ts`의 `abort()` 경로에서 하위 작업 취소 호출이 없다). 앱이 자손 중단을 보장하려면 별도 경로가 필요하다.

보완 확인: 앱이 소유한 엔진 프로세스를 트리째 종료하면(`taskkill /PID … /T /F`) 하위 표식이 즉시 멈췄다. 즉 프로세스 경계 종료는 동작하지만, 실행 중인 작업만 골라 중단하는 경로는 이 버전의 RPC에 없다.

## 5. 조치

- 어댑터 능력 `abortTreeVerified=false`로 기록한다.
- 하위 에이전트가 있는 작업의 중단 기능은 출시 차단 항목으로 남기고, SDK·확장·프로세스 그룹 관리 중 어떤 경로로 자손 중단을 구현할지 결정하기 전에는 중단 완료로 보고하지 않는다.
- 다음 검증 후보: 자손별 프로세스 그룹 추적, 작업 도구의 취소 가능성 확인, 엔진 확장 훅을 통한 하위 실행 등록.

## 6. 증거

- 원시 프레임 로그: `docs/evidence/TV-004/raw/tv-004.jsonl`, `docs/evidence/TV-004/raw/tv-004-control.jsonl`
- 요약(중단 전후 표식 샘플 포함): `docs/evidence/TV-004/raw/tv-004-summary.json`
- 하네스: `scripts/verification/omp-rpc/tv-004.mjs`
- 연결 REQ-008, REQ-016 / ADR-003

커밋한 로그는 `scripts/verification/omp-rpc/trim-logs.mjs`로 초대형 줄의 페이로드만 축약했다(줄 1354개 중 1030개). 이벤트 순서와 종류는 그대로 남아 있고, 전문은 하네스 재실행으로 다시 만들 수 있다.
