# 18. 개발·빌드·배포 가이드

2026-09-23 / 구현할 저장소 계약. 문서 검사, 계약·큐·SQLite·Git·Diff·파일·화면 모듈의 lint/typecheck/build/test:unit/test:integration을 추가했다. 앱 실행과 실제 연동·검증 명령은 아직 없다. [실측 도구 버전과 검증 범위](evidence/toolchain.md)를 확인한다.

## 1. 환경과 버전 확정

대상 실행·패키징·수용 검증은 Windows 11 x64를 우선 기준으로 한다. 일반 TypeScript·문서·도메인 검증은 Linux에서도 가능하나 PTY·디버거·메모리 검증을 대체하지 않는다.

필수: Git, 선택 IDE가 요구하는 Node 버전과 package manager, OMP가 요구하는 런타임, Java/Python 검증용 도구. 기본 package manager는 npm workspaces로 계획하되 채택 Theia 템플릿 요구와 충돌하면 ADR로 조정하고 하나만 유지한다. OMP 실행 런타임을 앱 백엔드 런타임과 무조건 같게 만들지 않는다.

IMP-01 산출: package.json engines/packageManager, lockfile, .node-version 또는 동등 파일, docs/evidence/toolchain.md. 'latest'를 재현 가능한 릴리스 기준으로 사용하지 않는다.

## 2. 저장소 구조

apps/desktop과 packages/{contracts,core,engine-omp,worktrees,processes,persistence,ide-integration,ui}, tests/{unit,integration,windows}, scripts, docs를 사용한다. 문서별 계약의 권위는 00의 색인을 따른다.

설정 예시는 비밀 없는 .env.example에, 사용자 인증 정보는 엔진 인증 또는 OS 저장소에 둔다. 실제 프로젝트·워크트리·사용자 로그는 저장소에 커밋하지 않는다.

## 3. 스크립트 구현 상태

| 명령 | 현재 상태·최종 계약 |
| --- | --- |
| npm ci | 구현: lockfile 그대로 설치 |
| npm run dev | 앱 미구현으로 명시적 실패. 향후 개발 데스크톱 실행, 명시한 테스트 데이터 루트 사용 |
| npm run build | 구현: 현재 모든 독립 패키지 빌드. 향후 앱 빌드 포함 |
| npm run lint | 구현: 현존 JS/TS 정적 규칙. 향후 앱 포함 |
| npm run typecheck | 구현: 현존 패키지 타입 검사. 향후 IDE·엔진 패키지 포함 |
| npm run docs:check | 구현: 상대 문서 링크·정의 ID·요구사항-수용 연결·표 구조·일본어 가나 검사. enum·모든 문장 내 참조 검증은 향후 확장 |
| npm run test:unit | 구현: 큐·Esc·12슬롯·정책·Diff·화면 상태 일부 검사. 향후 전체 상태 포함 |
| npm run test:integration | 구현: 임시 파일 SQLite·Git 워크트리/변경 가져오기·조건부 파일 저장. 향후 엔진 경계 포함 |
| npm run verify:omp:tv003 | 구현: 실제 OMP RPC 연결·프레임·요청 ID 검증. 로컬 인증 엔진 필요, CI 미실행 |
| npm run verify:omp:tv004 | 구현: 하위 에이전트 트리·중단 검증. 모델 호출 발생, CI 미실행 |
| npm run verify:omp:tv006 | 구현: 읽기 전용 강제 검증. 모델 호출 발생, CI 미실행 |
| npm run test:windows | 미구현: 실제 PTY·IDE·debug 시나리오 |
| npm run test:acceptance | 미구현: AT 시나리오 결과 생성 |
| npm run perf:collect | 미구현: PERF 측정·원시 결과 저장 |
| npm run package:win | 구현: scripts/package-windows-app.mjs가 ci→build→desktop install→plugins→rebuild→build→package 순서로 NSIS 설치본과 포터블을 만든다. 두 산출물은 파일명이 분리되어 있다(Setup/Portable). 네이티브 애드온 컴파일에는 Visual Studio Build Tools가 필요하고, 서명 인증서가 없으면 서명은 적용되지 않는다. 릴리스 산출물 판정은 CI desktop-windows 성공이 권위자다([검증용 빌드 기록](evidence/win-packaging/README.md)) |

각 스크립트는 실패 시 nonzero 종료해야 한다. 빈 echo로 통과시키지 않는다. 실제 OMP 시험은 별도 opt-in과 시험용 인증이 필요하며 CI에서 사용자 계정을 자동 사용하지 않는다.

## 4. 개발 규칙

TypeScript strict, 경계 입력 스키마 검증, public contract는 packages/contracts에서만 정의한다. 사용자 메시지는 한국어, 코드 식별자는 영어. 무관한 기능/리팩터링을 섞지 않는다. 테스트는 구현 복제보다 데이터 유실·경합·부작용 위험에 집중한다.

셸 실행은 인자 배열, 경로는 task 문맥으로 검증한다. UI에서 FS/Git/프로세스에 직접 접근하지 않는다. 예외를 빈 catch로 삼키지 않고 AppError로 전달한다. 다른 작업의 프로세스/파일을 ID 추측으로 다루지 않는다.

## 5. CI 계획

현재 기초 CI: Ubuntu/Windows에서 npm ci → docs:check → lint → typecheck → 현존 패키지 build → unit → 파일/SQLite/Git integration. 실행 결과는 [증거](evidence/toolchain.md)에 기록한다. 최종 PR CI: docs:check → lint/typecheck → unit → integration → build. Windows 영향 변경은 Windows runner에서 추가 실행한다. 실제 모델·비용이 있는 시험은 승인된 별도 job으로 분리하고 모의 시험과 구분한다.

main에 푸시했다고 자동 공개 릴리스하지 않는다. 첫 버전 릴리스는 명시적 태그/수동 workflow로 시작한다. 현재 기초 CI 외 제품 검증·패키징 자동화는 설치하지 않았다.

## 6. 패키지와 릴리스

릴리스 gate: 필수 AT 통과, Windows toolchain 고정, 알려진 제한·RAM 결과 포함, 라이선스/확장 배포 조건 확인, 깨끗한 기기 설치·실행·종료·재설치 확인.

산출: 설치 파일, 가능하면 portable 패키지, SHA-256 checksum, 버전·커밋·도구 버전, 릴리스 노트. 코드 서명 인증서가 없으면 unsigned 사실을 알리고 서명된 것처럼 표시하지 않는다. 사용자에게 보안 보호를 끄도록 유도하지 않는다.

앱 업데이트는 작업 실행 중 적용하지 않고 종료 후 적용한다. DB 마이그레이션 전 백업, 실패 시 원본 보존. 제거 프로그램은 사용자 데이터 삭제 여부를 별도로 묻고 외부 프로젝트·OMP 원본 세션은 제거하지 않는다.

## 7. 실환경이 없을 때

Windows·인증·확장 설치를 사용할 수 없으면 해당 검증을 BLOCKED로 기록하고 도메인/문서/모의 시험을 계속한다. 미검증 산출물을 완성 버전이라고 부르지 않는다. 제품 범위 변경이나 유료 인증·외부 권한이 필요할 때만 구체적 사유와 함께 사용자에게 묻는다.
