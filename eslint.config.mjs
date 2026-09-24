import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    // 빌드 산출물과 생성물은 lint 대상이 아니다. desktop의 lib은 번들 78MB라 힙을 초과한다.
    ignores: [
      "**/dist/**",
      "node_modules/**",
      "apps/ide-verification-host/**",
      "apps/desktop-extension/**",
      "apps/desktop/lib/**",
      "apps/desktop/src-gen/**",
      "apps/desktop/plugins/**",
      "apps/desktop/esbuild.mjs",
      "apps/desktop/gen-esbuild.*.mjs",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // 검증 스크립트는 Node 24에서 실행되므로 표준 전역을 허용한다.
    files: ["scripts/**/*.{mjs,cjs}"],
    languageOptions: {
      globals: {
        Buffer: "readonly",
        AbortSignal: "readonly",
        clearTimeout: "readonly",
        fetch: "readonly",
        process: "readonly",
        setTimeout: "readonly",
        WebSocket: "readonly",
      },
    },
  },
);
