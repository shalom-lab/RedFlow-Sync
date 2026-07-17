# RedFlow-Sync

将 [InfoFlow Picker](https://github.com) 存在 GitHub 的结构化图文（JSON + 图片），半自动填入小红书创作者服务平台发布页。

## 功能

- **Options / Popup**：配置 GitHub Token、仓库、分支、basePath、分类列表
- **右侧悬浮面板**：在 `creator.xiaohongshu.com/publish/*` 注入，按分类拉取内容卡片
- **去重状态**：`chrome.storage.local` 记录已上传 `fileId`，已同步卡片置灰
- **一键填入**：DOM 写入标题 / 正文，并跨域下载图片注入 `input[type=file]`

## 本地缓存（IndexedDB）

后台将仓库 JSON + 图片增量同步到扩展源 IndexedDB：

- 按 GitHub Contents API 的 `sha` 判断变更，未变则跳过
- 每 6 小时 `alarms` 自动同步；配置变更 / 面板「同步」也会触发
- 侧栏与导入优先读本地 Blob，不依赖当时网速
- Content Script 不能直连扩展 IDB，经 `chrome.runtime.sendMessage` 取数据

## 权限与 Chrome Web Store

为通过商店审核，权限刻意收窄：

| 类型 | 声明 | 说明 |
|------|------|------|
| `storage` | 安装时 | 仅存配置与上传历史 |
| `alarms` | 安装时 | 后台定时增量同步 |
| `optional_host_permissions` | 按需 | 仅 `api.github.com`、`raw.githubusercontent.com` |
| Content Script matches | 安装时 | 仅 `creator.xiaohongshu.com/publish/publish*` |

**未使用**：宽泛 `host_permissions`、`https://*.githubusercontent.com/*`、`tabs`、`scripting`、`declarativeNetRequest`。

上架单「Host permission justification」可写：仅用于读取用户自己配置的 InfoFlow GitHub 仓库中的 JSON/图片，经用户明确授权后访问，并缓存到本地以减少重复请求。

## 开发

```bash
npm install
npm run gen:icons   # 首次生成 public/icons
npm run dev         # 开发构建（输出到 dist）
npm run build       # 生产构建
```

Chrome 加载扩展：打开 `chrome://extensions` → 开发者模式 → 「加载已解压的扩展程序」→ 选择本项目的 `dist` 目录。

## 数据约定

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

## 核心模块

- `src/lib/dom-inject.ts` — 模块 D：标题/正文事件注入 + 图片 Blob→File→DataTransfer
- `src/lib/github.ts` — GitHub Contents API / Raw 拉取
- `src/lib/storage.ts` — 配置与 UploadHistory
- `src/contents/` — 发布页侧栏 UI
