# IDE 검증 호스트 (Theia)

TV-001/002 검증용 후보 IDE 호스트다. 제품 앱이 아니며 [IMP-02](../../docs/17-implementation-plan.md)의 산출물이다. Theia 1.75.0을 사용한다. VS Code API 지원 범위는 1.134.0이다(`@theia/application-package`의 `DEFAULT_SUPPORTED_API_VERSION`).

## 설치와 실행

```bash
cd apps/ide-verification-host
npm install --ignore-scripts   # 최초 1회, 대용량. 네이티브 컴파일을 피한다
node ../../scripts/verification/theia-host/patch-native-stubs.mjs   # 네이티브 모듈 스텁
npx theia build --mode development
npx theia download:plugins     # Open VSX 확장 내려받기
npx theia start --hostname 127.0.0.1 --port 3000 --plugins=local-dir:plugins
```

검증 자동화는 저장소 루트에서 `npm run verify:theia:tv001`로 실행한다. 이 명령은 원격 디버깅 포트를 연 헤드리스 브라우저로만 조작하므로 사용자 마우스·키보드·창 포커스를 가져가지 않는다.

## 대상과 제약

- 목표 대상은 Electron 데스크톱이지만 이 PC에는 Visual Studio 빌드 도구가 없어 네이티브 모듈(drivelist·native-keymap·keytar·@theia/ffmpeg·@vscode/windows-ca-certs)을 컴파일할 수 없다. 그래서 현재는 `browser` 타깃으로 빌드하고 헤드리스 Chrome으로 기능을 확인한다. 데스크톱 셸 검증은 환경 차단으로 남긴다.
- 스텁은 프록시 CA 목록, 드라이브 목록, 키보드 레이아웃, 자격 증명 저장을 비운다. 터미널(`node-pty`)과 파일 감시(`@parcel/watcher`)는 미리 빌드된 바이너리로 동작한다.
- 확장은 Open VSX에서 내려받는다. Pylance는 Open VSX에 없어 Python은 확장에 포함된 언어 서버를 쓴다.
