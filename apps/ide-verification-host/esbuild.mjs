/**
 * This file can be edited to adjust the ESBuild build process.
 * To reset, delete this file and rerun the `theia build` command.
 *
 * 검증 호스트 수정: 네이티브 컴파일이 필요한 @vscode/windows-ca-certs를 스텁으로 대체한다.
 * 프록시 CA 목록만 비게 되며, 이 PC에 Visual Studio 빌드 도구가 없어도 번들이 만들어진다.
 */
import { browserOptions, watch } from './gen-esbuild.browser.mjs';
import { nodeOptions } from './gen-esbuild.node.mjs';

import esbuild from 'esbuild';

const stubNativeModules = {
  name: 'awi-stub-native-modules',
  setup(build) {
    build.onResolve({ filter: /^@vscode\/windows-ca-certs$/ }, () => ({ path: 'windows-ca-certs-stub', namespace: 'awi-stub' }));
    build.onLoad({ filter: /.*/, namespace: 'awi-stub' }, () => ({
      contents: [
        'const listCertificates = async () => [];',
        'module.exports = listCertificates;',
        'module.exports.default = listCertificates;',
        'module.exports.listCertificates = listCertificates;',
      ].join('\n'),
      loader: 'js',
    }));
  },
};

browserOptions.plugins = [...(browserOptions.plugins ?? []), stubNativeModules];
nodeOptions.plugins = [...(nodeOptions.plugins ?? []), stubNativeModules];
// alias는 플러그인보다 먼저 적용되므로 두 번들 모두에서 확실히 대체된다.
// 드라이브 목록·키맵·자격 증명 저장은 네이티브 애드온이 없어 스텁으로 대체한다(로그인 자동 채움 등은 이 호스트에서 미검증).
const stubPath = (name) => `./stubs/${name}`;
const alias = {
  ...(browserOptions.alias ?? {}),
  ...(nodeOptions.alias ?? {}),
  "@vscode/windows-ca-certs": stubPath("windows-ca-certs.cjs"),
  drivelist: stubPath("drivelist.cjs"),
  "native-keymap": stubPath("native-keymap.cjs"),
  keytar: stubPath("keytar.cjs"),
};
browserOptions.alias = alias;
nodeOptions.alias = alias;

const browserContext = await esbuild.context(browserOptions);
const nodeContext = await esbuild.context(nodeOptions);


if (watch) {
    await Promise.all([
        browserContext.watch(),
        nodeContext.watch(),
    ]);
} else {
    try {
        await browserContext.rebuild();
        await browserContext.dispose();
        await nodeContext.rebuild();
        await nodeContext.dispose();
    } catch {
        process.exit(1);
    }
}
