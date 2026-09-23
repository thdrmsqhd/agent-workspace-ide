# 05. 작업 상태와 수명주기

2026-09-23 / 구현 기준. 연결: [API](07-api-events.md), [저장](06-data-storage.md), [복구](14-recovery-diagnostics.md).

## 1. 상태 모델

한 필드에 실행·병합·서버 상태를 혼합하지 않는다.

- phase: discussion | provisioning | execution | review | archived
- runState: idle | running | waiting_input | reconnecting | stopping | paused | failed
- integrationState: none | awaiting_approval | queued | preparing | conflicted | merging | merged | pushing | pr_pending | done | failed | unknown
- disposition: active | completed | cancelled
- queueMode: enabled | paused

불변조건: discussion은 실행용 워크트리가 없다. execution에는 준비 완료 워크트리가 있다. cancelled는 running이 아니다. integration의 부작용 상태와 실행 중 코드 변경을 겹치지 않는다. 서버 실행 여부는 Process에서 계산한다.

UI 우선순위: 취소 → 충돌 해결 필요 → 응답 필요 → 중단 처리 중 → 재연결 중 → 실패/확인 필요 → 반영 중/대기 → 작업 중 → 검토 대기 → 준비 중/중단됨/완료. 우선순위는 다른 상태를 삭제하지 않고 보조 배지로 남긴다.

## 2. 전이표

| 사건 | 이전 조건 | 변경 | 부작용·거절 조건 |
| --- | --- | --- | --- |
| 논의 생성 | 프로젝트 존재 | discussion/idle/active | 읽기 전용 세션 생성, 카드 보존 |
| 논의 입력 | discussion, 전송 가능 | runState=running 후 idle | 코드 쓰기는 항상 금지 |
| 작업 시작 | discussion/idle 또는 provisioning 실패 | provisioning → execution/idle | 불변 시작 요청ID, 워크트리 준비 저널 |
| 최초 요청 인계 | execution/idle | running | 수락과 실행 시작 별도 |
| 질문 도착 | 실행 세션 존재 | waiting_input | 같은 작업만 대기 |
| 답변 처리 | 유효한 열린 요청 | running 또는 idle | 만료·세션 교체 시 거절 |
| Esc | running/waiting_input/reconnecting | stopping → paused, queueMode=paused | 자손·단기 명령 종료 확인 필요 |
| 추가 지시로 재개 | paused, 결과 불명 없음 | running, queueMode=enabled | 미확인 부작용 있으면 먼저 복구 |
| 정상 실행 종료 | 메인 최종 종료+자손 정리 | queue 있으면 다음 실행, 없으면 review/idle | 지침 검증 결과 수집 |
| 검토 후 반영 | review, 변경 확정 | awaiting_approval 또는 queued | 수동 모드는 승인 필수 |
| 충돌 | preparing/merging | conflicted | 실행 재개 금지, 해결 흐름만 허용 |
| 로컬 반영 성공 | merging | merged | push/PR 필요 시 후속 단계 |
| 워크플로우 완료 | 모든 요구 단계 완료 | integration=done, disposition=completed | 코드만 완료하는 지침이면 병합 없이 완료 가능 |
| 후속 요청 | 아직 merged 아님 | execution/running | 단 반영 중이면 금지, 취소/복구 후 가능 |
| 병합 후 요청 | merged/pushing/pr_pending/done | 새 연결 작업 discussion | 원래 taskId에 쓰기 재개 금지 |
| 취소 | 삭제 전 모든 비최종 작업 | stopping 후 archived/cancelled | 진행 중 반영은 결과 확인 후 취소 표시 |
| 앱 재시작 | 실행 중 상태 기록 | paused 또는 복구 대기 | discussion/completed/cancelled 의미 보존 |

프로젝트 워크플로우가 코드 수정만 요구하면 '완료·미반영'이다. 완료 여부와 merged 여부는 분리한다. 최종 에이전트 응답만으로 push/PR 성공을 추정하지 않는다.

## 3. 동시성

작업별 변경 명령은 직렬 처리하고 expectedRevision을 사용한다. Esc는 우선 제어 큐로 받아 긴 모델 호출 완료를 기다리지 않되 저장 갱신은 같은 직렬 경계로 처리한다. 파일 시스템·Git 부작용은 DB 잠금을 잡은 채 장시간 수행하지 않는다.

반영 대기열은 저장소 공통 경로 단위다. 여러 작업의 준비/코딩은 병렬 가능하다. 실행 슬롯은 메인 코딩 작업 최대 12개이며 paused는 슬롯을 반환한다. 재개도 슬롯을 확보한다. 논의 세션은 코딩 슬롯을 소비하지 않으며 별도 고정 대화 수 제한은 두지 않는다.

## 4. 실행 완료 판정

OMP 이벤트 종료를 받더라도 유지 작업이나 자손 실행이 남아 있으면 완료로 표시하지 않는다. 메인의 최종 상태·하위 상태·실행 도구·미해결 질문을 대조한다. 개발 서버만 남아 있는 것은 정상 완료를 막지 않는다.

큐의 dispatching에서 프로세스가 죽으면 unknown으로 기록한다. 동일 프롬프트 자동 재전송 금지. 이 규칙은 정확히 한 번 실행을 보장한다는 주장이 아니라 중복을 피하기 위해 불확실 상태를 보존하는 설계다.

## 5. 취소·삭제·종료 구분

탭 닫기: 상태 변화 없음. Esc: 재개 가능한 중단. 취소: 기록을 보존하는 작업 종료. 영구 삭제: 별도 확인 후 앱 소유 자료만 제거. 앱 종료: 전체 소유 실행을 정리하고 기록 보존.

준비 중 취소는 생성 중인 앱 소유 워크트리만 보상 정리한다. 이미 파일 변경이 있으면 보관한다. 원본 프로젝트·외부 세션은 보상 대상으로 사용하지 않는다.
