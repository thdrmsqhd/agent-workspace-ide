# Agent Workspace IDE Desktop

독립 Windows 앱의 제품 셸이다. 검증용 `apps/ide-verification-host`와 달리 Theia의 `electron` 타깃을 사용한다.

Windows 개발 도구가 설치된 환경에서:

```powershell
npm run desktop:build
cd apps/desktop
npm run start
```

`desktop:build`는 의존성 설치 → Open VSX 확장 다운로드 → Electron native rebuild → production build 순으로 수행한다. 현재 CI는 Windows 네이티브 도구 체인을 보장하지 않으므로 실제 앱 패키징/수용 여부는 AT 증거로 별도 기록한다. Java/Python/debug/icons 확장 버전은 검증 호스트와 동일하게 고정한다.
