import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { crx } from "@crxjs/vite-plugin";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import manifest from "./manifest.config";

const rootDir = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  // Chrome 扩展页不能用站点根路径 /assets，必须相对路径
  base: "./",
  plugins: [react(), crx({ manifest })],
  resolve: {
    alias: {
      "@": resolve(rootDir, "src"),
    },
  },
  build: {
    sourcemap: process.env.NODE_ENV === "development",
    emptyOutDir: true,
  },
});
