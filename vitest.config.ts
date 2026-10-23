import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
    },
  },
  test: {
    // 默认 node 环境（绝大多数是纯逻辑用例）；组件测试各自用文件头 @vitest-environment jsdom 声明
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    // jsdom + userEvent 的组件用例空闲时 0.7~1s，多文件并行会按 CPU 争用放大到 5s 以上，默认 5s 太紧会随机红
    testTimeout: 15000,
  },
});
