import { defineManifest } from "@crxjs/vite-plugin";

/**
 * RedFlow-Sync — Manifest V3
 * UI：Chrome Side Panel（点击扩展图标打开）
 * Content Script：仅在发布页做 DOM 填入桥接
 */
export default defineManifest({
  manifest_version: 3,
  name: "RedFlow-Sync",
  version: "1.2.1",
  description:
    "将 InfoFlow 草稿索引同步到本地，半自动填入小红书创作者发布页",
  icons: {
    "16": "public/icons/icon16.png",
    "48": "public/icons/icon48.png",
    "128": "public/icons/icon128.png",
  },
  action: {
    default_icon: {
      "16": "public/icons/icon16.png",
      "48": "public/icons/icon48.png",
      "128": "public/icons/icon128.png",
    },
    default_title: "打开 RedFlow-Sync 侧栏",
  },
  side_panel: {
    default_path: "src/sidepanel/index.html",
  },
  background: {
    service_worker: "src/background/index.ts",
    type: "module",
  },
  permissions: ["storage", "alarms", "sidePanel", "tabs", "scripting"],
  host_permissions: ["https://creator.xiaohongshu.com/*"],
  optional_host_permissions: [
    "https://api.github.com/*",
    "https://raw.githubusercontent.com/*",
  ],
  content_scripts: [
    {
      matches: ["https://creator.xiaohongshu.com/publish/publish*"],
      js: ["src/contents/publish-bridge.ts"],
      run_at: "document_idle",
    },
  ],
});
