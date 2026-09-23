# TV-006 읽기 전용 논의 강제 검증 결과

2026-09-23. 판정: **통과(닫힌 구성 한정)**. 호스트 정책과 도구 목록으로 논의 모드의 쓰기·셸·MCP 쓰기 경로를 실제로 차단함을 확인했다. 도구 목록 제한만 쓰는 구성은 MCP 쓰기 경로를 막지 못했다.

## 1. 실행 조건

| 항목 | 값 |
| --- | --- |
| 실행일 | 2026-09-23 (KST) |
| OS | Windows 11 10.0.26200 (x64) |
| 엔진 | `omp` 18.2.5 (`~/.bun/bin/omp.exe`) |
| 모델 | `openai-codex/gpt-6-astra` |
| 작업대 | 임시 디렉터리의 격리 Git 프로젝트. 검증용 MCP 서버(쓰기 도구 1개)를 프로젝트 설정으로 등록 |
| 재현 명령 | `npm run verify:omp:tv006` |

## 2. 시험 구성과 결과

| 구성 | 결과 |
| --- | --- |
| 승인 정책 거부(`tools.approval`에 write·edit·bash·eval·task·hub·web_search = deny) | 모델이 write·bash·eval을 호출했고 엔진이 "Tool … is blocked by user policy"로 거부. 파일 해시·목록 무변경 |
| 도구 목록 제한(`--tools=read,glob,grep,todo`) | 노출 도구 11개 → 5개. 남은 `write`는 xd:// 장치 전용 전송이며 파일 쓰기는 거부됨. 파일 무변경 |
| 도구 목록 제한 + MCP 서버 등록 | MCP 쓰기 도구가 계속 실행됨(표식 파일 생성). **차단 실패** |
| 도구 목록 제한 + `mcp.enableProjectConfig=false` + 승인 정책 거부 | MCP 서버가 아예 기동하지 않음(시작 표식 없음). 프로젝트 읽기·검색은 정상 동작(`read`로 표식 문자열 확인) |

## 3. 확정한 논의 모드 구성

논의(읽기 전용) 세션은 다음 세 가지를 함께 적용해야 성립한다.

- 도구 목록: `read`, `glob`, `grep`, `todo`만 명시한다.
- 승인 정책: `tools.approval`에 `write`, `edit`, `bash`, `eval`, `task`, `hub`, `web_search`를 `deny`로 둔다.
- 프로젝트 MCP 설정: `mcp.enableProjectConfig`를 `false`로 두어 MCP 쓰기 도구를 기동 단계에서 제외한다.

이 구성은 사용자 전역 설정을 바꾸지 않고 실행별 `--config` 오버레이로만 적용할 수 있다. 오버레이 파일은 `docs/evidence/TV-006/raw/config/`에 있다.

## 4. 남은 한계

- 위 구성은 도구 경계의 강제이며 OS 수준 샌드박스가 아니다. 사용자 권한으로 실행되는 다른 프로그램이나 셸을 앱이 완전히 통제하지는 않는다.
- `write` 도구가 장치 전송으로 남으므로, 논의 세션에서 xd:// 장치 읽기가 필요한지 여부는 제품 결정이 필요하다. 현재 구성은 장치 쓰기도 함께 닫는다.
- MCP 서버를 켠 논의 세션(읽기 전용 MCP만 허용하는 형태)은 이번에 확정하지 않았다. 서버별 읽기·쓰기 구분이 불명확하면 13번 문서 원칙대로 논의 단계에서 허용하지 않는다.

## 5. 증거

- 원시 프레임 로그: `docs/evidence/TV-006/raw/`의 `tv-006-deny.jsonl`, `tv-006-allowlist.jsonl`, `tv-006-mcp-normal.jsonl`, `tv-006-mcp-restricted.jsonl`, `tv-006-closed.jsonl`
- 요약(도구 목록·거부 메시지·표식 상태 포함): `docs/evidence/TV-006/raw/tv-006-summary.json`
- 오버레이 파일: `docs/evidence/TV-006/raw/config/`
- 하네스: `scripts/verification/omp-rpc/tv-006.mjs`, `scripts/verification/omp-rpc/mcp-probe-server.mjs`
- 연결 REQ-004, REQ-031, REQ-032 / ADR-006

커밋한 로그는 `scripts/verification/omp-rpc/trim-logs.mjs`로 초대형 줄의 페이로드만 축약했다. 이벤트 순서와 판정 근거는 그대로 남아 있고, 전문은 하네스 재실행으로 다시 만들 수 있다.
