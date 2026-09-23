# 07. 내부 API와 이벤트 계약

2026-09-23 / 앱 내부 계약 v1. 아래 명칭은 본 앱 API이며 OMP 원시 RPC 이름과 혼동하지 않는다. [OMP 매핑](08-omp-adapter.md), [상태](05-task-lifecycle.md), [DB](06-data-storage.md).

## 1. 공통 봉투

```ts
type Command<T> = {
  apiVersion: 1; requestId: string; method: string;
  taskId?: string; expectedRevision?: number; payload: T;
};
type Reply<T> =
  | {requestId: string; status: "completed"; revision?: number; data: T}
  | {requestId: string; status: "accepted"; operationId: string}
  | {requestId: string; status: "rejected"; error: AppError};
type AppError = {code: string; message: string; retryable: boolean;
  operationId?: string; details?: Record<string, unknown>};
type Event<T> = {apiVersion: 1; eventId: string; sequence: number;
  taskId?: string; type: string; occurredAt: string; payload: T};
```

ID는 UUID, timestamp UTC ISO-8601. optional과 null은 구별한다. 누락은 변경하지 않음, null은 nullable 필드 지우기다. 미지원 필드는 검증 오류로 거절한다. scope별 revision 필수 명령은 해당 최신 revision을 전달한다.

같은 requestId·같은 payload는 기존 operation 결과를 반환한다. 같은 ID에 다른 payload는 E_REQUEST_REUSE다. accepted는 비동기 처리를 시작했다는 뜻이며 완료는 operation.finished 이벤트로 확인한다. UI 응답 타임아웃은 작업 취소가 아니다.

## 2. 도메인 자료형

ProjectRef={projectId}; TaskRef={taskId}; BranchSpec={targetBranch,baseCommit?}; SettingPatch={engineId?,modelId?,executionMode?}; AttachmentRef={attachmentId}; FileSelection={relativePath,changeKind,sourceHash?}; Approval={snapshotId,expectedTargetHead,policyHash}.

TaskSnapshot은 05의 상태 필드, revision, originalPrompt, projectId, worktreePath?, lastActivity?, changedFileCount, childCounts, pendingInputIds, dirtyBufferCount를 포함한다. 파일/프로세스 목록의 큰 본문은 별도 조회로 반환한다.

## 3. 명령 목록

모든 변경 명령은 operation 기록·상태 검증을 거친다. 아래 'v'는 expectedRevision 필수다. 일반 파일 편집·디버그는 IDE SDK 기능을 호출하지만 taskId 문맥과 파일 버전 확인은 동일하게 적용한다.

| ID / method | 입력 payload | 반환·주요 조건 |
| --- | --- | --- |
| CMD-01 project.register | path,name? | ProjectSnapshot; 중복 repo_key는 기존 projectId 안내 |
| CMD-02 project.updateSettings (v) | projectId,patch | ProjectSnapshot; 실행 중 task 설정 불변 |
| CMD-03 discussion.create | projectId,text,attachmentIds | TaskSnapshot; 원래 요청 저장 |
| CMD-04 discussion.send (v) | text,attachmentIds | MessageRef; discussion만 가능 |
| CMD-05 task.start (v) | branch:BranchSpec,settings:SettingPatch,saveAsProjectDefault:boolean | operationId; 준비 완료 이벤트까지 실행 안 함 |
| CMD-06 task.send (v) | text,attachmentIds,delivery:"immediate" 또는 "queued" | MessageRef; 반영 중 거절 |
| CMD-07 queue.update (v) | messageId,text,attachmentIds | MessageSnapshot; queued만 |
| CMD-08 queue.delete (v) | messageId | deletedId; queued만 |
| CMD-09 task.abort | reason:"user" 또는 "shutdown" | operationId; 반복 요청 합침 |
| CMD-10 task.resume (v) | text?,attachmentIds? | operationId; 결과 unknown이면 거절 |
| CMD-11 input.respond (v) | inputId,response:{value? 또는 confirmed? 또는 cancelled?} | InputRequestSnapshot; 타입별 한 값만 |
| CMD-12 attachment.add | scope:{projectId?,taskId?},kind,path?,clipboardBytes?,selection? | AttachmentSnapshot; 로컬 경로는 백엔드 검증 |
| CMD-13 attachment.remove | attachmentId,draftId | removedId; 이미 전송한 메시지는 변경 불가 |
| CMD-14 import.preview | projectId,sourceSessionRef | ImportPreview; 원본/선택 가능한 변경 해시 |
| CMD-15 import.execute | previewId,selectedFiles,branch | operationId; 원본 스냅샷 재확인 |
| CMD-16 task.review (v) | reason? | ReviewSnapshot; 실행 완료 후 최신 diff 준비 |
| CMD-17 integration.approve (v) | approval:Approval | operationId; 승인과 snapshot 결합 |
| CMD-18 integration.retry (v) | integrationId,expectedStage | operationId; 재조회로 중복 방지 |
| CMD-19 conflict.continue (v) | integrationId,resolutionSnapshotId | operationId; 충돌 없음 검증 후 진행 |
| CMD-20 task.cancel (v) | reason? | operationId; 코드 보존 |
| CMD-21 task.deletePreview | taskId | DeletePreview; 파일·기록·실행 경고 |
| CMD-22 task.delete | previewId,confirmationToken | operationId; 확인 이후 변경되면 다시 미리보기 |
| CMD-23 process.start | role,executable,args,cwd,envRefs,ports? | ProcessSnapshot; 역할·문맥 정책 검사 |
| CMD-24 process.stop | processId | operationId; PID 시작 식별자 대조 |
| CMD-25 view.save | taskId?,layout,tabs,cursors,scroll,draftRevision? | ViewState; 실행 영향 없음 |
| CMD-26 app.shutdown | savePolicy:"preserve" | operationId; 버퍼 보존 성공과 실행 정리 확인 |
| CMD-27 file.save | uri,bufferRevision,expectedDiskHash,content | FileVersion; 충돌이면 E_FILE_CONFLICT |
| CMD-28 snapshot.create | taskId,reason | SnapshotRef; 비교 기준 기록 |
| CMD-29 settings.apply (v) | taskId,patch,scope:"task" 또는 "project" | EffectiveSettings; 유휴/다음 실행에 적용 |
| CMD-30 extension.install | extensionId,version,source | operationId; 전역 적용, 호환/배포 검증 |
| CMD-31 task.createFollowup | sourceTaskId,text,attachmentIds | 새 Discussion; source가 merged여야 함 |
| CMD-32 project.relocate (v) | projectId,newPath | ProjectSnapshot; 동일 repo 확인, 실행 작업 있으면 거절 |
| CMD-33 file.change | uri,operation:"create" 또는 "rename" 또는 "delete",newUri?,expectedDiskHash? | FileVersion/삭제 결과; IDE 확인·휴지통 정책 적용 |

file.change는 영구 삭제를 자동 수행하지 않는다. OS 휴지통 사용 가능 시 해당 흐름을 사용하고, 불가능하면 영구 삭제 대상을 명시하고 사용자 확인을 받는다. task.delete도 기존 확인 범위를 벗어난 자료는 제거하지 않는다.

## 4. 조회

query.projectList, taskList(projectId?,cursor?,limit=50), taskGet(taskId), messages(taskId,cursor?,limit=100), children(taskId), review(taskId,snapshotId?), processes(taskId), operation(operationId), importSessions(projectId), settings(scope), diagnostics(taskId?), extensions().

페이지 최대 200. cursor는 조회 스냅샷 식별자를 포함하며 유효하지 않으면 E_STALE_CURSOR. 이벤트 재연결은 subscribe(afterSequence)와 snapshot 조회를 결합한다. 이벤트 보존 범위를 벗어나면 snapshot과 그 기준 sequence를 반환한다. 화면은 snapshot 이전 이벤트를 다시 적용하지 않는다.

## 5. 이벤트 목록

| type | 최소 payload | 소비자 |
| --- | --- | --- |
| task.changed | taskId,revision,changes | 카드·상태·탭 |
| agent.changed | agentId,parentAgentId?,status,activity | 세션 트리 |
| message.delta | messageId,offset,text | 대화 스트림, 임시 이벤트 |
| message.committed | messageId,contentRef,deliveryState | 대화 영속 결과 |
| queue.changed | taskId,revision,items | 대기열 |
| input.required / input.closed | inputId,kind,expiresAt?,state | 알림·빠른 답변 |
| files.changed | taskId,uris,diskVersions | 파일 트리·미저장 충돌 |
| process.changed | processId,role,state,exitCode? | 터미널·서버·디버거 |
| integration.changed | integrationId,stage,resultHead? | 검토·충돌 |
| operation.finished | operationId,result?,error? | 모든 비동기 조작 |
| connection.changed | taskId,state,retryAt? | 연결 배너 |

message.delta는 재전송·영속 event sequence 대상이 아닌 휘발성 스트림이다. 영속 Event 봉투의 sequence는 나머지 이벤트에 부여한다. delta는 streamId와 offset으로 정렬하고 재연결 시 committed 본문/엔진 스냅샷으로 복원한다.

## 6. 오류 코드와 사용자 조치

| 코드 | 의미 | 자동 재시도 |
| --- | --- | --- |
| E_VALIDATION / E_UNSUPPORTED | 형식/기능 미지원 | 안 함 |
| E_REVISION_CONFLICT / E_REQUEST_REUSE | 경쟁 갱신/ID 오용 | 재조회 후 사용자 작업 재평가 |
| E_STATE / E_CAPACITY | 현재 상태/12개 실행 한도 | 상태 변화 후 명시적 재개 |
| E_POLICY / E_APPROVAL_STALE | 실행 범위 위반/승인 기준 변경 | 승인 재획득 또는 명시적 지시 |
| E_FILE_CONFLICT / E_GIT_CONFLICT | 편집/병합 충돌 | 사용자 해결 |
| E_PATH / E_PORT_BUSY | 경로 없음/포트 선점 | 경로 확인 / 새 포트 후보 |
| E_ENGINE / E_PROTOCOL / E_DISCONNECTED | 엔진/프레임/연결 오류 | 14 규칙 |
| E_AUTH | 엔진 인증 필요 | 사용자 인증 후 |
| E_UNKNOWN_OUTCOME | 실제 결과 불명 | 조회만 재시도, 부작용 재전송 금지 |
| E_STORAGE / E_MIGRATION | 저장·스키마 오류 | 쓰기 정지 후 복구 |
| E_STALE_CURSOR / E_REQUEST_EXPIRED | 조회/질문 만료 | 다시 조회 |
| E_RESOURCE | 메모리·디스크 등 부족 | 자동 무한 반복 금지 |

모든 실패는 사용자용 한국어 메시지와 기계용 code를 분리한다. 로그용 상세 스택은 UI 본문 대신 진단에 둔다. IPC는 신뢰한 앱 프런트엔드에서만 접근하고 임의 웹 콘텐츠가 명령을 호출하지 못하게 한다.

## 7. revision·선택 자료·조회 결과 세부

expectedRevision은 CMD-02/32에서 project, CMD-07/08에서 message, CMD-11에서 input_request, 나머지 v 명령에서 task revision이다. CMD-29의 project scope 저장은 task와 project revision을 둘 다 확인하도록 payload에 expectedProjectRevision을 추가한다.

코드 selection={fileUri,startLine,startColumn,endLine,endColumn,content,diskHash?}; 줄·열은 1부터, 끝 위치는 제외다. view payload의 layout={leftWidth,rightWidth,leftCollapsed,rightCollapsed,centerMode,expandedPanel?}; centerMode=conversation|split|code|terminal|review다.

tabs=[{taskId,order,isOpen}], cursors=[{uri,line,column,selection?}], scroll={conversationOffset,fileOffsets,terminalOffsets}. 전역 활성 탭은 'overview' 또는 taskId다. task별 초안은 drafts에 따로 저장하고 view.save가 메시지를 전송하지 않는다.

ImportPreview={previewId,sourceSessionRef,sourceHead,sourceManifestHash,files:FileSelection[],warnings,createdAt}; DeletePreview={previewId,taskId,revision,ownedPaths,artifactCount,runningProcesses,dirtyBuffers,unmergedChanges,confirmationToken}. 프리뷰는 조건 변경 시 즉시 무효화하며 10분 유효를 초깃값으로 한다.

ReviewSnapshot={snapshotId,taskId,baseCommit,targetHead,taskHead?,files,summary,checks:[{name,status,command?,evidence?}],serverUrls,policyHash}. check.status=passed|failed|not_run|unknown이다.

ProjectSnapshot은 projectId,name,repoPath,repoKey,defaultBranch,revision; MessageSnapshot은 messageId,taskId,content,attachmentIds,deliveryMode,queueState,revision; AttachmentSnapshot은 attachmentId,kind,displayName,sizeBytes,readiness,warnings; ProcessSnapshot은 processId,taskId,role,state,cwd,portBindings,exitCode?다. 목록 조회는 {items,nextCursor?,snapshotSequence}를 반환한다.

API timeouts는 UI 기다림을 끝낼 뿐 operation을 자동 취소하지 않는다. 가벼운 조회는 기본 10초, 비동기 operation 수락은 30초다. 실제 실행의 종료는 operation.finished로 받는다.

FileVersion={uri,diskHash,sizeBytes,encoding,eol,modifiedAt}; FileVersion의 content 본문은 별도 읽기로 가져온다. MessageRef={messageId}, SnapshotRef={snapshotId}, InputRequestSnapshot={inputId,taskId,sessionId,kind,payload,state,expiresAt?,revision}, EffectiveSettings={taskId,settings,sourceRefs,policyHash,revision}다.
