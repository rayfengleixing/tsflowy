import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// KaTeX 字体裁剪：katex.min.css 为每个字体声明 woff2/woff/ttf 三重回退源，
// 三者合计约 1MB，而 WebView2 必定支持 woff2。构建期只保留 woff2，
// 去掉 woff/ttf 源后 Vite 不再产出这些字体文件（约省 800KB）。
function katexWoff2Only(): Plugin {
  return {
    name: "katex-woff2-only",
    enforce: "pre",
    transform(code, id) {
      if (!id.includes("katex") || !id.endsWith(".css")) return null;
      const next = code.replace(/,\s*url\([^)]*?\.(?:woff|ttf)\)\s*format\("(?:woff|truetype)"\)/g, "");
      return next === code ? null : { code: next, map: null };
    },
  };
}

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react(), tailwindcss(), katexWoff2Only()],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
    },
  },

  // 依赖分包：把 React / Radix / 图标 / 状态库拆成独立 chunk，
  // 主包更小、冷启动可并行解析，升级依赖时缓存命中率也更高（业务代码改动不再让 vendor 失效）。
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes("node_modules")) return undefined;
          if (id.includes("react-dom") || id.includes("/react/") || id.includes("scheduler")) return "react";
          if (id.includes("@radix-ui") || id.includes("radix-ui")) return "radix";
          if (id.includes("lucide-react")) return "icons";
          if (id.includes("zustand")) return "state";
          return undefined;
        },
      },
    },
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
