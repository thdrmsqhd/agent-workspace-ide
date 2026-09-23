# 06. 데이터 모델과 저장 명세

2026-09-23 / 설계 계약. 연결: [상태](05-task-lifecycle.md), [API](07-api-events.md), [복구](14-recovery-diagnostics.md).

## 1. 저장 위치와 소유권

앱 데이터 루트는 OS가 반환하는 사용자 앱 데이터 경로 아래 AgentWorkspaceIDE다. 하드코딩한 사용자명은 금지한다. 하위 경로: state.sqlite, artifacts/{sha256}, logs/{date}, sessions/{taskId}, recovery/{taskId}, worktrees/{projectId}/{taskId}. 사용자가 워크트리 루트를 바꿀 수 있게 하되 시작 시 쓰기·길이·동일 파일 시스템 조건을 검사한다.

프로젝트 원본은 외부 소유, 앱 생성 워크트리는 앱 소유다. OMP 원래 세션도 외부 소유다. DB에는 정규화된 절대 경로와 표시용 경로를 구분한다. Windows 경로 키는 실제 경로와 대소문자 비교 특성에 맞게 정규화한다.

## 2. 타입·제약

ID는 UUID 문자열, 시각은 UTC ISO-8601, 크기는 byte 정수, revision은 0부터 증가하는 정수다. 아래 ID는 모두 PK이며 외래 키는 ON DELETE RESTRICT를 기본으로 한다. JSON 필드는 앱에서 버전별 스키마 검증 후 저장한다. 암호·토큰 값은 DB에 넣지 않는다.

| 테이블 | 주요 필드 | 인덱스·제약 |
| --- | --- | --- |
| projects | id, name, repo_path, repo_key, default_branch, config_json, revision, created_at | repo_key UNIQUE |
| tasks | id, project_id, original_prompt, phase, run_state, integration_state, disposition, queue_mode, base_commit, target_branch, branch_name, worktree_path, linked_task_id, config_json, revision, created_at, updated_at | project_id FK, linked_task_id FK nullable, (project_id, created_at) |
| agent_sessions | id, task_id, parent_agent_id, engine, engine_version, engine_session_ref, status, last_activity, current_action_json | task_id FK, parent_agent_id FK nullable, (task_id, engine_session_ref) UNIQUE |
| messages | id, task_id, agent_id, role, content, delivery_mode, queue_state, queue_position, revision, created_at, updated_at | task_id FK, (task_id, queue_position) UNIQUE for queue records |
| drafts | id, task_id nullable, project_id nullable, scope, text, attachment_ids_json, revision | scope=global/task, scope별 소유자 고유 키 |
| artifacts | id, sha256, kind, relative_path, size_bytes, mime_type, ref_count | sha256+kind UNIQUE |
| message_attachments | id, message_id nullable, draft_id nullable, artifact_id nullable, source_path, selection_json, kind | exactly one message_id/draft_id; FKs |
| processes | id, task_id, role, pid, started_identity, owner_group, cwd, state, command_json, exit_code, log_ref | task_id FK, PID 단독 unique 금지 |
| port_leases | id, task_id, process_id nullable, host, port, state | (host,port) UNIQUE while reserved/bound |
| input_requests | id, task_id, session_id, external_request_id, kind, payload_json, expires_at, state, revision | (session_id,external_request_id) UNIQUE |
| operations | id, request_id, scope_key, method, payload_hash, state, result_json, error_json, created_at | request_id UNIQUE |
| operation_steps | id, operation_id, ordinal, kind, state, before_json, after_json | (operation_id,ordinal) UNIQUE |
| events | id, task_id nullable, sequence, event_type, payload_json, created_at | sequence UNIQUE global |
| integrations | id, task_id, repo_key, target_ref, expected_head, task_head, result_head, stage, policy_snapshot_json, pr_url, snapshot_id | task_id FK, repo_key index |
| change_snapshots | id, task_id, base_commit, head_commit, manifest_artifact_id, created_at | task_id FK |
| editor_buffers | id, task_id, file_uri, disk_hash, draft_artifact_id, buffer_revision, dirty | (task_id,file_uri) UNIQUE |
| view_states | id, task_id nullable, layout_json, tabs_json, cursors_json, scroll_json, updated_at | task_id UNIQUE when not null |
| schema_migrations | id, checksum, applied_at | id UNIQUE |

drafts의 고유 키는 scope=global이면 project_id, scope=task이면 task_id다. 둘 중 하나만 유효해야 한다. 원래 요청은 불변이며 사용자가 추가 지시를 해도 갱신하지 않는다. 위 표의 구조는 첫 마이그레이션의 기준이며 각 enum 값은 05와 07에서 가져온다.

## 3. 트랜잭션 경계

메시지 생성+대기열 위치+이벤트+operation 수락 결과를 한 트랜잭션에 넣는다. queued 항목 편집은 revision과 state를 조건으로 UPDATE하고 영향 행 0이면 E_REVISION_CONFLICT다. dispatching 전이는 동일 트랜잭션으로 선점한다.

Git·프로세스 실행은 트랜잭션 밖에서 수행하되 작업 의도를 먼저 operations에 기록한다. 성공 후 실제 결과와 이벤트를 함께 확정한다. DB 확정 전 실행 완료 응답을 잃으면 unknown으로 복원하고 외부 결과를 확인한다.

SQLite는 foreign_keys 활성화, WAL, busy_timeout 5000ms를 초기 설계값으로 사용한다. 단일 앱 백엔드가 쓰기를 소유한다. UI가 DB 파일에 직접 연결하지 않는다. 외부 네트워크 드라이브에 DB를 두지 않는다.

## 4. 파일 저장과 원자성

첨부·스냅샷은 임시 파일에 쓰고 flush 후 원자적 rename으로 최종 경로를 만든 다음 DB 참조를 기록한다. rename 성공 후 DB 실패한 고아 파일은 즉시 추정 삭제하지 않고 유지 기간 후 참조 대조로 정리한다. ref_count만 믿지 말고 실제 참조를 확인한다.

미저장 버퍼는 debounce 500ms와 탭 닫기/정상 종료 직전 저장한다. 저장 실패 시 탭을 강제 닫지 말고 재시도·별도 저장을 제공한다. 강제 OS 종료에서 마지막 입력 최대 500ms 손실 가능성을 명시하며 이를 숨기지 않는다. 영속화 성공 이전에는 저장 완료 표시를 하지 않는다.

## 5. 이벤트·로그 보존

도메인 상태 변경과 사용자 메시지는 장기 보존한다. token delta는 실시간 전달 후 메시지 완료 시 본문으로 합친다. 모든 token을 events에 무제한 저장하지 않는다. 도구 결과 큰 본문은 artifact 참조로 둔다.

기본 로그 회전은 파일당 10MiB, 10개다. 대화·diff·사용자 첨부는 이 회전 정책으로 삭제하지 않는다. 로그는 인증 헤더·비밀 환경 변수·설정 값을 가린다. 사용자가 명시한 영구 삭제에서만 작업 기록과 참조 없는 첨부를 제거한다.

## 6. 마이그레이션·복구

마이그레이션 전 온라인 백업 API 등 일관된 방법으로 백업하고 적용한 checksum을 기록한다. 단순히 실행 중 sqlite 파일 하나만 복사하지 않는다. 다운그레이드는 자동 스키마 역변환 대신 해당 버전 백업 복원으로 처리한다.

디스크 부족: 신규 작업·반영·메시지 인계를 멈추고 파일 편집 복구를 우선한다. 손상 DB는 원본을 보존하고 복사본에서 진단한다. 새 빈 DB로 조용히 덮지 않는다.

공식 참고: https://www.sqlite.org/lang_transaction.html . 실행 검증 TV-011 전 이 설계의 내구성이 입증되었다고 주장하지 않는다.

## 7. 열거형·관계 세부

messages.role=user|assistant|tool|system, delivery_mode=immediate|queued|discussion, queue_state=none|queued|dispatching|accepted|finished|failed|unknown|deleted. 삭제한 대기 메시지는 이력상 deleted로 남기되 실행 후보에서 제외한다.

processes.state=starting|running|stopping|exited|unknown, port_leases.state=reserved|bound|released, input_requests.state=open|answered|expired|cancelled, operations.state=accepted|running|succeeded|failed|unknown, operation_steps.state=pending|running|succeeded|failed|unknown.

tasks의 상태 enum은 05가 권위자이며 agent_sessions.status는 idle|running|waiting_input|stopping|paused|completed|failed|unknown이다. agent_sessions.current_action_json은 actionKind,summary,fileUri?,startedAt을 포함한다. 첨부 kind=image|file|folder|code, artifacts.kind=attachment|snapshot|buffer|tool-output|log다.

original_prompt는 TEXT NOT NULL, worktree_path/base_commit은 discussion에서 NULL 가능, messages.content는 빈 문자열 가능하나 전송 시 text 또는 첨부가 있어야 한다. source 파일 경로는 NULL 가능하고 선택 코드에는 content artifact가 있어야 한다.

SQL migration은 CHECK·NOT NULL·FK·부분 unique index로 표현 가능한 제약을 반드시 반영한다. enum을 추가할 때 과거 읽기 호환과 schema version을 올린다. integration의 특정 행위 순서·역할별 cwd 같은 도메인 제약은 서비스와 통합 시험에서도 검사한다.

## 8. 구현 현황

`packages/persistence`의 첫 마이그레이션은 projects/tasks/messages/operations/events/schema_migrations, 두 번째는 drafts/view_states에 한정한다. foreign_keys·WAL·busy_timeout, 원자적 큐 상태 저장, 초안/보기 상태, requestId 중복 판별, 전달 선점, 재시작 시 불명 결과 격리, SQLite 온라인 백업을 구현했다. 기존 v1 스키마를 v2로 올리기 전에 온라인 백업하며 미지원 스키마는 덮지 않고 오류로 중단한다.

agent_sessions, artifacts, attachments, processes, port_leases, input_requests, operation_steps, integrations, snapshots, editor_buffers 및 큰 파일 자료의 아티팩트 저장은 미구현이다. `packages/files`의 조건부 파일 저장은 구현했으나 DB 복구 버퍼와 아직 묶이지 않았다. 경로·Git 소유권 검증은 등록 서비스가 아직 없으므로 `createProject`와 `recordPreparedExecution`의 호출자가 확인해야 한다. 현재 검사 결과는 [도구·검증 기록](evidence/toolchain.md)에 적는다.
