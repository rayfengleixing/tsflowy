// @ts-check
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import reactCompiler from "eslint-plugin-react-compiler";

export default tseslint.config(
  {
    ignores: [
      "dist/**",
      "src-tauri/**",
      "node_modules/**",
      ".github/**",
      "scripts/**",
      "tailwind.config.js",
      "vite.config.ts",
      "vitest.config.ts",
      "eslint.config.js",
      "_lint.json",
    ],
  },
  js.configs.recommended,
  // Phase 4 优化 · P1#5：为了 0-error 落地，先用 recommended（非 strict）。
  // 下一个迭代再单独开 PR 升 strictTypeChecked。
  ...tseslint.configs.recommendedTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ["*.js", "*.ts", "*.tsx"],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-compiler": reactCompiler,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "react-hooks/exhaustive-deps": "warn", // 先 warn，不阻塞
      "react-compiler/react-compiler": "warn",

      // ---- 正确性 error：红线 ----
      "no-debugger": "error",
      eqeqeq: ["error", "smart"],
      "prefer-const": "error",
      "no-console": ["warn", { allow: ["warn", "error", "trace"] }],
      "no-undef": "off", // TS 负责

      // ---- Hooks（先 warn，防止老代码一次性 16 条 error 拦死） ----
      "react-hooks/rules-of-hooks": "warn",

      // ---- 类型安全类：统一降到 warn，留到下一专项迭代升 strict ----
      "@typescript-eslint/no-unsafe-assignment": "warn",
      "@typescript-eslint/no-unsafe-member-access": "warn",
      "@typescript-eslint/no-unsafe-argument": "warn",
      "@typescript-eslint/no-unsafe-call": "warn",
      "@typescript-eslint/no-unsafe-return": "warn",
      "@typescript-eslint/no-base-to-string": "warn",
      "@typescript-eslint/prefer-optional-chain": "warn",
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/prefer-string-starts-ends-with": "warn",
      "@typescript-eslint/prefer-regexp-exec": "warn",
      "@typescript-eslint/prefer-for-of": "warn",
      "@typescript-eslint/array-type": "warn",
      "no-useless-escape": "warn",
      "@typescript-eslint/no-non-null-assertion": "warn",
      "@typescript-eslint/no-unnecessary-condition": "warn",
      "@typescript-eslint/restrict-template-expressions": "warn",
      "@typescript-eslint/restrict-plus-operands": "warn",
      "@typescript-eslint/no-unnecessary-type-assertion": "warn",
      "@typescript-eslint/no-dynamic-delete": "warn",
      "@typescript-eslint/no-empty-function": "warn",
      "@typescript-eslint/no-meaningless-void-operator": "warn",
      "@typescript-eslint/use-unknown-in-catch-callback-variable": "warn",
      "@typescript-eslint/unified-signatures": "warn",
      "@typescript-eslint/non-nullable-type-assertion-style": "warn",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/prefer-nullish-coalescing": "warn",
      "@typescript-eslint/consistent-type-definitions": "warn",
      "@typescript-eslint/strict-boolean-expressions": "off",
      "@typescript-eslint/no-confusing-void-expression": "off",
      "@typescript-eslint/no-floating-promises": "off",
      "@typescript-eslint/no-misused-promises": "off",
    },
  },
  {
    // 测试文件放宽
    files: ["**/*.test.ts", "**/*.test.tsx"],
    rules: {
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
  {
    files: ["src/lib/db.ts", "src/lib/*.ts"],
    rules: { "no-console": "off" },
  },
);
