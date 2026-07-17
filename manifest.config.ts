import { defineManifest } from "@crxjs/vite-plugin";

/**
 * RedFlow-Sync — Manifest V3（面向 Chrome Web Store 的最小权限）
 *
 * 审核友好策略：
 * 1. permissions: storage（配置/历史）+ alarms（后台增量同步，审核通常友好）
 * 2. 不声明安装时 host_permissions
 * 3. GitHub 两精确源放入 optional_host_permissions，用户手势下授权
 * 4. 小红书仅 content_scripts.matches 覆盖发布页
 * 5. IndexedDB 缓存在扩展后台，侧栏/填图走本地，减少重复拉网
 */
export default defineManifest({
  manifest_version: 3,
  name: "RedFlow-Sync",
  version: "1.2.1",
  description:
    "将 InfoFlow Picker 存在 GitHub 的图文半自动填入小红书创作者发布页",
  icons: {
    "16": "public/icons/icon16.png",
    "48": "public/icons/icon48.png",
    "128": "public/icons/icon128.png",
  },
  action: {
    default_popup: "src/popup/index.html",
    default_icon: {
      "16": "public/icons/icon16.png",
      "48": "public/icons/icon48.png",
      "128": "public/icons/icon128.png",
    },
    default_title: "RedFlow-Sync",
  },
  options_page: "src/options/index.html",
  background: {
    service_worker: "src/background/index.ts",
    type: "module",
  },
  permissions: ["storage", "alarms"],
  optional_host_permissions: [
    "https://api.github.com/*",
    "https://raw.githubusercontent.com/*",
  ],
  content_scripts: [
    {
      // 尽量窄：仅图文发布相关路径，而非整站 creator.*
      matches: ["https://creator.xiaohongshu.com/publish/publish*"],
      js: ["src/contents/publish-panel.tsx"],
      css: ["src/contents/panel.css"],
      run_at: "document_idle",
    },
  ],
});
