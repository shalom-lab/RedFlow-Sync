# RedFlow-Sync

<div align="center">

<img src="logo.svg" alt="RedFlow-Sync Logo" width="128" />

**将 InfoFlow Picker 的 GitHub 图文，半自动填入小红书创作者发布页**

[![Chrome](https://img.shields.io/badge/Chrome-MV3_Extension-4285F4?logo=google-chrome&logoColor=white)](https://github.com/shalom-lab/RedFlow-Sync/releases)
[![Release](https://img.shields.io/github/v/release/shalom-lab/RedFlow-Sync?include_prereleases&sort=semver)](https://github.com/shalom-lab/RedFlow-Sync/releases)
[![Vite](https://img.shields.io/badge/Vite-React_TS-646CFF?logo=vite&logoColor=white)](https://vitejs.dev/)

</div>

## ✨ 功能特性

### ⚙️ 配置与面板
- **Options / Popup**：配置 GitHub Token、仓库、分支、`basePath`、分类列表
- **右侧悬浮面板**：在 `creator.xiaohongshu.com/publish/*` 注入，按分类浏览内容卡片
- **去重状态**：`chrome.storage.local` 记录已上传 `fileId`，已同步卡片置灰

### 🚀 一键填入
- **标题 / 正文**：DOM 事件注入，适配小红书创作者编辑器
- **图片灌入**：经 Background 拉取 Blob，注入 `input[type=file]`（绕过 Content Script CORS）

### 💾 本地缓存（IndexedDB）
- **增量同步**：按 GitHub Contents API 的 `sha` 判断变更，未变则跳过
- **定时拉取**：每 6 小时 `alarms` 自动同步；配置变更 / 面板「同步」也会触发
- **离线可用**：侧栏与导入优先读本地 Blob，不依赖当时网速
- **消息桥接**：Content Script 经 `chrome.runtime.sendMessage` 访问扩展源 IDB

## 🚀 快速开始

### 环境要求

- Node.js 20+
- npm

### 安装与构建

```bash
npm install
npm run gen:icons   # 首次生成 public/icons
npm run build       # 生产构建 → dist/
```

### 加载扩展（Chrome）

1. 打开 `chrome://extensions`
2. 开启「开发者模式」
3. 「加载已解压的扩展程序」→ 选择本项目的 `dist` 目录

### 配置

1. 准备 [GitHub Personal Access Token](https://github.com/settings/tokens)（需仓库读权限）
2. 打开扩展 Options / 侧栏 Settings
3. 填写 Token、`owner`、`repo`、`branch`、`basePath`、分类列表并保存
4. 首次使用时按提示授权 GitHub 主机权限，然后点「同步」

开发模式：`npm run dev`（同样输出到 `dist`）。

## 📖 数据约定

与 [InfoFlow Picker](https://github.com/shalom-lab/InfoFlow-Picker) 共用同一套仓库结构：

```
{basePath}/
├── {category}/
│   └── {fileId}.json
└── Images/
    └── {category}/
        └── {fileId}.png
```

| 小红书字段 | 映射 |
|-----------|------|
| 正文 | `jsonData.content` |
| 标题 | `jsonData.notes` 前 20 字；空则 `【AI灵感】{fileId}` |
| 图片 | `raw.githubusercontent.com/{owner}/{repo}/{branch}/{basePath}/{jsonData.image}` |

## 🛠️ 开发

### 常用脚本

```bash
npm run dev           # 开发构建
npm run build         # 类型检查 + 生产构建
npm run package       # 打包 release/*.zip
npm run sync-version  # 同步 package.json / manifest 版本
```

### 发布

推送 semver tag（如 `v1.2.1`）会触发：

- **Release**：构建并上传 zip 到 GitHub Release
- **Publish Store**：上传到 Chrome Web Store（需配置 Secrets）

### 核心模块

- `src/lib/dom-inject.ts` — 标题/正文事件注入 + 图片 Blob→File→DataTransfer
- `src/lib/github.ts` — GitHub Contents API / Raw 拉取
- `src/lib/storage.ts` — 配置与 UploadHistory
- `src/lib/idb.ts` / `src/lib/sync.ts` — IndexedDB 缓存与增量同步
- `src/contents/` — 发布页侧栏 UI
- `src/background/` — Service Worker、权限与媒体代理

## 🔧 技术栈

- **Manifest V3** + `@crxjs/vite-plugin`
- **Vite** + **React** + **TypeScript**
- **IndexedDB** 本地媒体缓存
- **GitHub Contents / Raw API**

## 🤝 贡献

欢迎提交 Issue 和 Pull Request！

## 🙏 致谢

- [InfoFlow Picker](https://github.com/shalom-lab/InfoFlow-Picker) — 数据采集与仓库结构上游
- 所有贡献者和用户

---

<div align="center">

**如果这个项目对您有帮助，请给个 ⭐ Star！**

Made with ❤️ by [shalom-lab](https://github.com/shalom-lab)

</div>
