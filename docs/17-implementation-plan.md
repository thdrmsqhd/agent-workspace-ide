# 17. 구현 작업 분해와 의존성 계획

2026-09-23. 각 작업은 구현 에이전트가 수행한다. IMP-01 기초 환경, IMP-05의 일부 입력 검사, IMP-07의 순수 큐·슬롯 규칙과 IMP-06의 첫 SQLite 저장 계층을 구현했다. IMP-02/03 연동 검증은 사용자 지시에 따라 후속으로 미룬다. 실제 앱·전체 DB 스키마·연동 코드는 아직 없다. 실행 범위는 [도구 버전·기초 검증](evidence/toolchain.md)을 따른다.

## 1. 진행 규칙

문서 읽기 순서는 00→04/04a→05~14→15/16→17/18이다. 제품 구현 전에 TV 기반의 기술 검증을 수행한다. 모의 어댑터로 도메인·화면을 먼저 만들 수 있으나 실제 연결 완료로 보고하지 않는다.

독립 작업은 동일 계약에 맞춰 병렬 개발 가능하지만 Git 병합은 순차 처리한다. 여기서 병렬 개발 가능성은 이 대화에서 별도 에이전트를 자동 호출하라는 뜻이 아니다.

## 2. 작업표

| ID | 선행 | 수정 범위·산출물 | 종료 기준·검증 |
| --- | --- | --- | --- |
| IMP-01 | 없음 | monorepo, package manager lock, Node/OMP/IDE 버전 기록, 18의 스크립트 | clean install·문서 검사 실행. 임의 앱 완성 보고 금지 |
| IMP-02 | IMP-01 | IDE 검증 호스트, 필수 확장 manifest, 작업 2개 전환 spike | TV-001/002 증거, 조건부 ADR 재판정 |
| IMP-03 | IMP-01 | OMP RPC 검증 harness, capability manifest, 정책 훅 spike | TV-003/004/006 결과, read-only/abort 실제 확인 |
| IMP-04 | IMP-02,IMP-03 | 소규모 메모리 기준 도구 | TV-012 예비 비교, 실패면 기반 재평가 |
| IMP-05 | IMP-01 | packages/contracts: CMD/event/error, DTO schema | 계약 유효/무효 입력 검증, 버전 호환 규칙 |
| IMP-06 | IMP-05 | packages/persistence: migration, artifacts, drafts, operations | TV-011 핵심 장애 주입, FK·트랜잭션 |
| IMP-07 | IMP-05,IMP-06 | packages/core: 상태 머신·큐·슬롯·정책 | TV-005, AT-08/10/22 |
| IMP-08 | IMP-05,IMP-06 | packages/worktrees: 등록·준비·가져오기·소유 저널 | TV-007, AT-03/17. 세션 부분은 IMP-10과 통합 |
| IMP-09 | IMP-05,IMP-06 | packages/processes: PTY·역할 그룹·포트·종료 | TV-008/013, AT-10/12/16 |
| IMP-10 | IMP-03,IMP-05,IMP-07,IMP-09 | packages/engine-omp: 실제 이벤트·질문·재개·세션 이전 | AT-05/06/11/17, engine fake만으로 종료 불가 |
| IMP-11 | IMP-05,IMP-07 | packages/ui: 상단/좌측/중앙탭/우측, 카드·시나리오 조작 | SCN 전체 버튼 목록과 AT-01/02/05~09 UI |
| IMP-12 | IMP-02,IMP-06,IMP-09,IMP-11 | packages/ide-integration: 파일·확장·debug·dirty buffers | AT-07/13/14/15, 비선택 서비스 유지 |
| IMP-13 | IMP-08,IMP-11,IMP-12 | packages/ui + diff worker: snapshot·비교·연결·충돌 | AT-21, spacer 0 증거 |
| IMP-14 | IMP-07,IMP-08,IMP-10,IMP-13 | Integration Coordinator·승인·반영·충돌·정리 | TV-009/014, AT-18~20 |
| IMP-15 | IMP-06,IMP-09,IMP-10,IMP-14 | 재시작·복구·진단, 종료 동작 | AT-11/12, 장애 주입 증거 |
| IMP-16 | IMP-11~IMP-15 | Windows 통합 앱, 모든 SCN/REQ 수용 결과 | AT-01~23 PASS 또는 명시된 BLOCKED 목록 |
| IMP-17 | IMP-04,IMP-16 | 성능 도구·최적화·3/12 실행·장시간 결과 | PERF-01~07, 절감 결과와 미달 공개 |
| IMP-18 | IMP-16,IMP-17 | Windows 설치/업데이트/삭제·패키지·릴리스 노트 | 재현 가능 패키지, 18의 릴리스 gate |

IMP-11의 mock 상태와 실제 API 연결은 분리하여 mock 데모를 실제 앱으로 오인하지 않게 한다. IMP-08의 세션 가져오기 최종 완료는 IMP-10까지 필요하다. IMP-02/03 실패로 도메인 설계와 무관한 작업을 전부 중단하지 않는다.

## 3. 첫 구현 착수 묶음

현재 진행 순서는 IMP-01 뒤 IMP-05 독립 계약 → IMP-07 순수 규칙 → IMP-06 SQLite 핵심 트랜잭션이다. IMP-05/06/07 전체 완료에는 나머지 명령 DTO, 영속 테이블·파일 저장·정책, 실제 실행 경계가 필요하다. IMP-02/03의 IDE·OMP 실제 연동 검증과 해당 버전 고정은 후속으로 보류한다. 검증하지 않은 런타임·확장 버전을 임의로 잠그지 않는다.

## 4. 작업별 인계 형식

각 작업 설명에는 목적, 관련 REQ/SCN/ADR/TV/AT, 변경 가능한 모듈, 선행 계약, 구현 내용, 실패 처리, 증거, 남은 제한, 다음 작업을 적는다. 예: IMP-07은 파일 UI를 바꾸지 않고 task/queue domain을 구현하며 dispatch 경쟁·Esc 후 소비 정지를 증명한다.

설계 변경이 필요하면 이유·대안·영향 REQ를 ADR에 기록한다. 필수 기능을 빼는 선택은 새 제품 결정이므로 사용자에게 묻는다. 파일명·함수명 같은 일반 구현 선택은 중단하지 않고 일관된 규칙으로 처리한다.

## 5. 완료의 정의

빌드 성공만으로 완료가 아니다. 관련 수용 기준과 오류 흐름, 데이터 보존, Windows 필요 증거, 문서 갱신이 완료되어야 한다. 실제 수행한 검증만 보고한다. 네트워크·인증·Windows 부재로 불가한 항목은 환경 차단으로 남기고 나머지는 진행한다.
