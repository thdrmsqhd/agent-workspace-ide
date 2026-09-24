## CI 판정 (권위자)

2026-09-24, 저장소 공개 전환으로 GitHub Actions가 정상 실행되면서 release 경로 전체가 통과했다.

- `desktop-windows` run [35989238780](https://github.com/thdrmsqhd/agent-workspace-ide/actions/runs/35989238780): **success**, 9m17s. 14단계 전부 success — root `npm ci` → `npm run build` → desktop `install --ignore-scripts --install-links` → `download:plugins` → `rebuild`(ffmpeg + electron native + `@vscode/windows-ca-certs`) → `theia build` → electron-builder(`nsis`+`portable`) → 아티팩트 `agent-workspace-ide-windows`(747,082,873 bytes).
- `foundation` run [35989238691](https://github.com/thdrmsqhd/agent-workspace-ide/actions/runs/35989238691): **success** (ubuntu-latest + windows-2022 양쪽).

이로써 릴리스 산출물은 MSVC + Electron 헤더로 CI에서 만들어지며, 아래 로컬 MinGW 기록은 권한이 없는 환경에서 파이프라인을 선검증할 때 쓰는 대체 경로다.

## 검증용 Windows 패키징 기록 (MSVC 없이 수행)

2026-09-24. 이 PC(Windows 11, Node 24.19, 관리자 권한 없음)에서 `apps/desktop`의 프로덕션 빌드·패키징을 실제로 통과시킨 기록이다. **릴리스 산출물이 아니라 파이프라인 검증용**이며, 릴리스 판정은 CI `desktop-windows`(windows-2022 + Visual Studio Build Tools + Electron 헤더) 성공이 권위자다.

## 왜 MSVC를 쓰지 못했나

- 이 PC에는 Visual Studio C++ 빌드 도구가 없다(node-gyp: `could not find a version of Visual Studio 2017 or newer`, `Visual Studio C++ core features missing`). 등록만 남은 Build Tools 2022 인스턴스는 설치 경로가 `C:\Program`으로 손상돼 있고 `2022`·`18` 폴더가 비어 있다.
- 설치에는 관리자 승인이 필요한데, UAC가 보안 데스크톱(`PromptOnSecureDesktop=1`)에서 뜨므로 computer_use로도 승인 버튼을 누를 수 없다. `Start-Process -Verb RunAs`는 이 세션에서 "지원되지 않는 요청"으로 거부되고, 부트스트래퍼 단독 실행은 `exit=66`, 탐색기 경유 실행은 `ERROR_INSTALL_USEREXIT(1602)`으로 끝났다.
- 대안으로 관리자 권한이 필요 없는 **LLVM-MinGW UCRT clang**(`git-diff-editor-tools/llvm-mingw-20260616-ucrt-x86_64`)으로 애드온을 직접 빌드했다.

## 수행한 명령

```
# Electron 헤더 확보(관리자 불필요)
npx node-gyp install --target=42.8.1 --dist-url=https://electronjs.org/headers --arch=x64

# N-API(C) 애드온: @theia/ffmpeg (build/Release/ffmpeg.node)
clang --target=x86_64-w64-windows-gnu -shared -O2 -DNAPI_VERSION=2 -DNODE_GYP_MODULE_NAME=ffmpeg \
  -I<cache>/42.8.1/include/node -o <pkg>/build/Release/ffmpeg.node native/ffmpeg.c native/win-ffmpeg.c <cache>/42.8.1/x64/node.lib

# C++(node-addon-api) 애드온: @vscode/windows-ca-certs, drivelist → -static 필수(libc++ 정적 링크)
clang++ --target=x86_64-w64-windows-gnu -shared -O2 -std=c++17 -static ...

# 빌드·패키징
npm --prefix apps/desktop run build
npx electron-builder --win nsis portable --publish never -c.npmRebuild=false -c.win.signAndEditExecutable=false
```

`-c.npmRebuild=false`가 필요한 이유: electron-builder의 기본 네이티브 리빌드가 MSVC를 요구한다(@parcel/watcher 등은 플랫폼 패키지에 프리빌드가 들어 있어 리빌드가 불필요하다). `-c.win.signAndEditExecutable=false`가 없으면 코드서명 도구 압축 해제가 심볼릭 링크 권한을 요구해 실패한다.

## 결과

- `npm --prefix apps/desktop run build` → browser·node·electron **전부 0 errors**.
- electron-builder → exit=0, `dist/Agent-Workspace-IDE-Setup-0.1.0-x64.exe`(NSIS 설치본)와 `dist/Agent-Workspace-IDE-Portable-0.1.0-x64.exe`(포터블) 두 산출물 생성. 수정 전에는 두 타깃이 같은 `artifactName`을 써서 포터블이 설치본을 덮어썼다.
- 패키지 내부 확인(asar): `lib`, `src-gen`, `package.json`, `plugins`(고정 확장 6종 VSIX), `node_modules/@awi/*` 13개, `@awi/theia-product-extension` 포함. 네이티브 애드온은 `app.asar.unpacked`로 분리(crypt32, keymapping, drivelist, @parcel/watcher, msgpackr, ripgrep).
- 미포함: `@theia/ffmpeg`(dev 전이 의존성). 생성된 `lib/backend/electron-main.js`가 ffmpeg를 참조하지 않아 **빌드 타임 전용**이며 런타임 결함이 아니다. Electron의 `ffmpeg.dll` 교체는 빌드 시 수행된다.

## 앱 기동 확인

패키징된 `dist/win-unpacked`의 실행 파일을 그대로 실행해 기동을 확인했다.

- 첫 실행: 백엔드가 `Cannot find module 'drivelist/build/Release/drivelist.node'`로 죽었다. `drivelist`(N-API C++)도 `--ignore-scripts` 때문에 컴파일되지 않은 상태였고, upstream 프리빌드도 없다(`prebuild-install --runtime napi` → `No prebuilt binaries found`). 같은 clang으로 빌드해 드라이브 조회까지 확인했다.
- 두 번째 실행: 백엔드가 크래시(종료코드 0xFFFF7003)로 죽었다. 원인은 MinGW 빌드 애드온이 **`node.exe`를 import**하기 때문이다(공식 프리빌드 애드온은 KERNEL32만 import해 호스트 이름과 무관하게 로드된다). 로더는 import 이름과 일치하는 모듈을 찾으므로, 산출물 exe 이름(`Agent Workspace IDE.exe`)에서는 애드온이 로드되지 않는다.
- 그래서 **동일 바이너리를 `node.exe` 이름으로 복사해 실행**했다(내용은 같은 파일, 이름만 다름). 그러면 애드온이 로드되고 앱이 정상 기동한다: `Starting backend`, `Attaching security token`, `Startup sequence completed: 733.6 ms`, 백엔드 기동 시퀀스 완료, parcel-watcher 동작, 프로세스 3개 유지. 확인 후 프로세스를 종료하고 임시 `node.exe`를 삭제했다.
- 이 이름 우회는 **MinGW 빌드에만 해당**한다. CI의 MSVC + Electron 헤더 빌드에서는 생기지 않는다. 릴리스 실행 검증은 CI 산출물로 다시 해야 한다.

## 검증 범위와 한계

- 실제 애드온 소스로 빌드한 것: `@theia/ffmpeg`(코덱 13개 열거 확인), `@vscode/windows-ca-certs`, `drivelist`(드라이브 조회 확인).
- **`native-keymap`은 스텁**: V8 C++ API 애드온이라 MinGW(Itanium 망글링)로는 MSVC 심볼(`v8::Isolate::GetCurrent` 등)을 해결할 수 없다. `index.js`가 요구하는 3개 함수만 N-API로 구현한 검증용 스텁이며, 키맵 기능은 검증되지 않았다.
- 위 애드온들은 Node 헤더/`node.lib`가 아니라 Electron 42.8.1 헤더로 컴파일했지만 툴체인이 MSVC가 아니므로, 릴리스에서는 MSVC + Electron 헤더로 다시 빌드해야 한다.
- CI(`desktop-windows`)는 GitHub Actions 결제/한도 문제로 실행 자체가 시작되지 않아 아직 판정 근거가 없다.
