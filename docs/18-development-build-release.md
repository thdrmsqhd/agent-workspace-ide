# 18. 개발·빌드·배포 가이드

2026-09-23 / 구현할 저장소 계약. 현재 저장소는 문서 단계이며 아래 npm 명령·workflow는 아직 생성되지 않았다. IMP-01에서 실제 스크립트를 만들고 검증한 후 사용한다.

## 1. 환경과 버전 확정

대상 실행·패키징·수용 검증은 Windows 11 x64를 우선 기준으로 한다. 일반 TypeScript·문서·도메인 검증은 Linux에서도 가능하나 PTY·디버거·메모리 검증을 대체하지 않는다.

필수: Git, 선택 IDE가 요구하는 Node 버전과 package manager, OMP가 요구하는 런타임, Java/Python 검증용 도구. 기본 package manager는 npm workspaces로 계획하되 채택 Theia 템플릿 요구와 충돌하면 ADR로 조정하고 하나만 유지한다. OMP 실행 런타임을 앱 백엔드 런타임과 무조건 같게 만들지 않는다.

IMP-01 산출: package.json engines/packageManager, lockfile, .node-version 또는 동등 파일, docs/evidence/toolchain.md. 'latest'를 재현 가능한 릴리스 기준으로 사용하지 않는다.

## 2. 저장소 구조

apps/desktop과 packages/{contracts,core,engine-omp,worktrees,processes,persistence,ide-integration,ui}, tests/{unit,integration,windows}, scripts, docs를 사용한다. 문서별 계약의 권위는 00의 색인을 따른다.

설정 예시는 비밀 없는 .env.example에, 사용자 인증 정보는 엔진 인증 또는 OS 저장소에 둔다. 실제 프로젝트·워크트리·사용자 로그는 저장소에 커밋하지 않는다.

## 3. 구현할 스크립트

| 명령 | IMP-01 이후 실제 동작 |
| --- | --- |
| npm ci | lockfile 그대로 설치 |
| npm run dev | 개발 데스크톱 실행, 명시한 테스트 데이터 루트 사용 |
| npm run build | 타입·패키지·앱 빌드 |
| npm run lint | 정적 규칙 |
| npm run typecheck | 모든 패키지 타입 검사 |
| npm run docs:check | 링크·ID·enum 참조·금지 언어 혼입 검사 |
| npm run test:unit | 상태·큐·정책 순수 로직 |
| npm run test:integration | 임시 Git/DB/엔진 모의 경계 |
| npm run test:windows | 실제 PTY·IDE·debug 시나리오 |
| npm run test:acceptance | AT 시나리오 결과 생성 |
| npm run perf:collect | PERF 측정·원시 결과 저장 |
| npm run package:win | Windows 패키지 생성, 테스트 안 된 서명 완료를 주장하지 않음 |

각 스크립트는 실패 시 nonzero 종료해야 한다. 빈 echo로 통과시키지 않는다. 실제 OMP 시험은 별도 opt-in과 시험용 인증이 필요하며 CI에서 사용자 계정을 자동 사용하지 않는다.

## 4. 개발 규칙

TypeScript strict, 경계 입력 스키마 검증, public contract는 packages/contracts에서만 정의한다. 사용자 메시지는 한국어, 코드 식별자는 영어. 무관한 기능/리팩터링을 섞지 않는다. 테스트는 구현 복제보다 데이터 유실·경합·부작용 위험에 집중한다.

셸 실행은 인자 배열, 경로는 task 문맥으로 검증한다. UI에서 FS/Git/프로세스에 직접 접근하지 않는다. 예외를 빈 catch로 삼키지 않고 AppError로 전달한다. 다른 작업의 프로세스/파일을 ID 추측으로 다루지 않는다.

## 5. CI 계획

PR: docs:check → lint/typecheck → unit → integration → build. Windows 영향 변경은 Windows runner에서 추가 실행한다. 실제 모델·비용이 있는 시험은 승인된 별도 job으로 분리하고 모의 시험과 구분한다.

main에 푸시했다고 자동 공개 릴리스하지 않는다. 첫 버전 릴리스는 명시적 태그/수동 workflow로 시작한다. 이 가이드는 workflow 파일 작성 계약이며 현재 자동화가 설치됐다는 뜻이 아니다.

## 6. 패키지와 릴리스

릴리스 gate: 필수 AT 통과, Windows toolchain 고정, 알려진 제한·RAM 결과 포함, 라이선스/확장 배포 조건 확인, 깨끗한 기기 설치·실행·종료·재설치 확인.

산출: 설치 파일, 가능하면 portable 패키지, SHA-256 checksum, 버전·커밋·도구 버전, 릴리스 노트. 코드 서명 인증서가 없으면 unsigned 사실을 알리고 서명된 것처럼 표시하지 않는다. 사용자에게 보안 보호를 끄도록 유도하지 않는다.

앱 업데이트는 작업 실행 중 적용하지 않고 종료 후 적용한다. DB 마이그레이션 전 백업, 실패 시 원본 보존. 제거 프로그램은 사용자 데이터 삭제 여부를 별도로 묻고 외부 프로젝트·OMP 원본 세션은 제거하지 않는다.

## 7. 실환경이 없을 때

Windows·인증·확장 설치를 사용할 수 없으면 해당 검증을 BLOCKED로 기록하고 도메인/문서/모의 시험을 계속한다. 미검증 산출물을 완성 버전이라고 부르지 않는다. 제품 범위 변경이나 유료 인증·외부 권한이 필요할 때만 구체적 사유와 함께 사용자에게 묻는다.
