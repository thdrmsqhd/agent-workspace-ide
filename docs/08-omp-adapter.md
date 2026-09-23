# 08. OMP 어댑터 구현 명세

2026-09-23. 공개 RPC 문서 확인과 설계이며 실제 엔진 실행 결과가 아니다. TV-003~007이 실행 검증이다.

## 1. 경계와 초기화

작업별 실행 프로세스를 생성하고 cwd를 해당 워크트리로 설정한다. 준비 중 논의 세션은 원본 프로젝트를 읽되 읽기 전용 도구 정책이 먼저 설치되어야 한다. shell 문자열로 명령을 합치지 않고 executable·args 배열로 시작한다.

초기 순서: 바이너리 경로/버전 확인 → 프로세스 시작 → ready → 지원 프로토콜 선택 → 도구 정책/설정 → 하위 구독 → 세션 확인 → 실행 가능 이벤트. startupTimeout 기본 15초, 명령 수락 timeout 30초. 모델 실행 시간은 이 수락 timeout에 포함하지 않는다.

선택 엔진의 정확한 커밋·버전·기능은 capabilities 결과로 저장한다. 필요한 도구 제한이 불가능하면 실제 프로젝트의 논의/실행을 열지 않고 검증 실패로 처리한다.

## 2. 앱 기능과 RPC 대응

| 앱 기능 | 문서상 연결 지점 | 구현 주의 |
| --- | --- | --- |
| 새 요청/유휴 작업 실행 | prompt | 수락과 실행 종료 분리 |
| 실행 중 즉시 지시 | steer 또는 prompt의 streamingBehavior | 이미 실행된 변경 되돌리기 아님 |
| 앱 후속 큐 | 앱이 보유 후 유휴에서 prompt | 엔진 follow_up 큐에 선적재하지 않음 |
| 중단 | abort, 별도 bash에는 abort_bash | 자손·외부 명령 중단 범위 실측 필요 |
| 상태 복원 | get_state, get_subagents | 실제 snapshot과 앱 기록 대조 |
| 하위 카드 | set_subagent_subscription, get_subagent_messages | 기본 progress, 상세 필요 시 events |
| 기존 세션 | switch_session 등 | 새 cwd 안전성·복제는 별도 검증 |
| 모델 | get_available_models, set_model | 작업 설정 스냅샷 갱신 |
| 과거 대화 | get_messages_page | stale cursor·busy 구별 |
| 질문 | extension_ui_request/response | 요청ID·세션ID 결합, 만료 처리 |
| 앱 도구 | set_host_tools, host_tool_call/result | 이것만으로 내장 도구가 제한된다고 가정 금지 |

## 3. 전송 규칙

수신은 ready에 광고된 프레임 제한을 사용한다. v2 지원 시 협상하고 chunk의 순서·개수·바이트 길이를 검증한 뒤 UTF-8로 복원한다. stdin 명령에 같은 큰 chunk 전송이 가능하다고 가정하지 않는다. 첨부가 입력 제한을 넘으면 경로 참조 또는 명시적 크기 오류를 사용한다.

stdout은 프로토콜 전용, stderr는 진단. stdout 소비는 UI가 느려도 계속하여 엔진 종료가 막히지 않게 한다. UI로 보낼 delta는 묶어 전달하고 큰 이력은 페이지 처리한다. 잘못된 프레임은 세션 불명 상태로 격리하고 전체 앱을 종료하지 않는다.

## 4. 완료와 재연결

prompt 응답 성공은 수락이다. agent_end의 최종 여부를 확인하고 자손·도구 상태를 함께 대조한다. 모델을 호출하지 않은 명령도 있으므로 local-only 응답을 처리한다. 버전별 실제 필드는 공식 타입과 계약 시험에서 고정한다.

stdio 프로세스가 종료되면 이전 파이프에 재접속할 수 없다. 앱의 '재연결'은 엔진 생존 확인 또는 새 프로세스에서 지속 세션을 재개하는 복구를 포함한다. 마지막 부작용 명령을 자동 반복하지 않는다.

## 5. 세션 이전

원본 세션을 외부 소유로 유지한다. 세션 파일 복제·branch·handoff 중 문맥·도구 결과·경로 보존을 충족하는 공식 경로를 TV-007로 선택한다. 과거 절대 경로는 새 cwd와 구별해 컨텍스트에 알리고, 모든 새 쓰기 대상은 현재 워크트리 경계에서 검증한다. 방법을 확인하기 전 원본 세션을 직접 편집하지 않는다.

## 6. 질문·인증·하위 작업

입력 요청은 앱 DB에 만료 시각과 저장하며 빠른 답변과 상세 대화의 동시 응답 중 먼저 확정된 하나만 전달한다. 만료 후 엔진이 기본값으로 처리했으면 실제 결과를 표시한다. 앱은 승인 필요 질문의 timeout을 허용으로 변환하지 않는다.

인증은 엔진의 지원 흐름을 따른다. 보안 입력이 RPC에서 지원되지 않으면 해당 엔진의 터미널 인증을 안내한다. 앱 일반 채팅에 비밀번호·토큰을 받지 않는다.

하위 에이전트는 사용자 직접 지시 대상이 아니다. 접힘 여부와 기본 progress 구독은 무관하다. 과거 transcript의 byte cursor가 reset되면 캐시를 교체하고 중복 메시지를 누적하지 않는다. 무제한 생성 정책은 자원 무한 보장을 의미하지 않는다.

## 7. 능력 계약과 차단

AdapterCapabilities: protocolVersions, subagentEvents, abortTreeVerified, readOnlyEnforced, sessionRelocationVerified, imageInput, hostTools, historyPaging, modelSwitch. advertised와 verified를 별도 기록한다.

필수 실패: readOnlyEnforced=false면 실제 논의 차단, abortTreeVerified=false면 중단 기능 출시 차단, sessionRelocationVerified=false면 기존 세션 이전 출시 차단. 화면 모형·모의 어댑터는 개발 가능하되 실제 기능 완료 표시 금지.

참고: https://github.com/can1357/oh-my-pi/blob/main/docs/rpc.md 및 docs/sdk.md. 이번 조사 RPC 파일 blob: b91b20a85aca2eacc7272cac7f1a55370449bc05. 버전 고정 전 main을 배포 의존성으로 사용하지 않는다.
