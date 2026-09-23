import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/dist/**", "node_modules/**", "apps/ide-verification-host/**"] },
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
