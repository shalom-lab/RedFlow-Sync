# RedFlow-Sync

<div align="center">

<img src="logo.svg" alt="RedFlow-Sync logo" width="128" />

**把 InfoFlow 草稿同步到本地，半自动填入小红书创作者发布页并「暂存离开」**

[![Chrome](https://img.shields.io/badge/Chrome-MV3_Extension-4285F4?logo=google-chrome&logoColor=white)](https://github.com/shalom-lab/RedFlow-Sync/releases)
[![Release](https://img.shields.io/github/v/release/shalom-lab/RedFlow-Sync?include_prereleases&sort=semver)](https://github.com/shalom-lab/RedFlow-Sync/releases)
[![Vite](https://img.shields.io/badge/Vite-React_TS-646CFF?logo=vite&logoColor=white)](https://vitejs.dev/)

</div>

## ✨ 功能特性

### 📋 侧栏工作台
- **Chrome 侧栏**：点击扩展图标打开，页签为 **主页 / 历史 / 设置**
- **设置**：分块配置 GitHub 数据源、提交方式、自动化与停顿节奏
- **去重**：IndexedDB 记下已处理的 `id`，卡片置灰；可单独清空发布标记或草稿列表（配置不动）

### 📝 填入发布页
- **提交方式（设置可选）**
  - **存草稿**：不勾选页面「定时发布」，点白色「暂存离开」
  - **定时发布**：勾选并填写定时后，点红色「定时发布」
- **标题 / 正文**：标题取 `wechat_title`；正文为关键词摘要、回复词和话题行
- **必选话题**：`#图美AI` `#ChatGPT` `#美图提示词`，再加上 JSON 里的 `keywords`
- **合集**：自动选设置里的合集名（默认 **ChatGPT美图**，按名字匹配）
- **群聊 / 引用笔记**：默认关闭（设置里可开）；开启后群聊名为空点第一项，引用笔记点「我的笔记」第一项
- **AI 声明**：默认在「添加内容类型声明」里选「笔记含AI合成内容」（可在设置关闭）
- **必选话题**：默认 `#图美AI #ChatGPT #AI作图提示词`，可在设置改
- **定时窗口**（仅「定时发布」模式）：约 2 小时后～未来 14 天、白天 10:00–20:00 随机写入
- **配图**：导入时再下载；优先读 `infoflow-data/Prompt/{id}.json` 的 `image/images`

### 🤖 自动化
- **开始自动化**：待处理满 5 的倍数才跑，一批 5 篇；暂停则等本批结束
- **每天自动 5 篇**：设置里打开后，侧栏开着 **且** 已打开小红书发布页才跑
- **不刷新发布页**：灌图 / 填文 / 提交拆步，按内容多少停顿；已在 `/publish` 上不再整页 reload
- **停顿节奏**：设置里可调各步等待毫秒数，或一键切换「默认 / 快速 / 稳健」预设

### 💾 本地缓存
- **轻量同步**：默认只拉 `data/wechat_newspic_drafts.json`，配图按需下载
- **定时拉取**：每 6 小时 `alarms` 同步；保存设置或手动同步也会触发

## 🚀 快速开始

### 环境要求

- Node.js 20+
- npm
- 已登录 [小红书创作者](https://creator.xiaohongshu.com/publish/publish?target=image)

### 安装与构建

```bash
npm install
npm run gen:icons   # 首次生成 public/icons
npm run build       # 先清空 dist，再 tsc + vite
```

### 加载扩展（Chrome）

1. 打开 `chrome://extensions`
2. 开启「开发者模式」
3. 「加载已解压的扩展程序」→ 选择本项目的 `dist` 目录
4. 点击工具栏图标 → 打开 **侧栏**
5. 以后每次 `npm run build` 后，在扩展页点 **重新加载**

开发：`npm run dev`（同样输出到 `dist`）。

### 配置

1. 准备 [GitHub Personal Access Token](https://github.com/settings/tokens)（私有仓需要读权限）
2. 打开侧栏 → **设置**
3. 默认仓库 `shalom-lab/InfoFlow` @ `master`
   - 草稿索引：`data/wechat_newspic_drafts.json`
   - 配图目录：`infoflow-data/Images/Prompt`
4. 保存并授权 GitHub 访问，同步草稿列表（配图在导入时再下）

## 📖 使用指南

1. 先打开并保持 [图文发布页](https://creator.xiaohongshu.com/publish/publish?target=image) 在前台，**不要手动刷新**
2. 主页点单条 **导入**，或待处理满 5 篇后点 **开始自动化**
3. 流程：拉图 → 上传图文 → 填标题/正文/话题/合集 →（定时模式则填定时）→ 提交 → 标记已处理
4. **设置 → 提交方式** 选存草稿或定时发布；默认声明 **笔记含AI合成内容**；**停顿节奏** 可按机器速度微调

### 停顿节奏（毫秒）

| 项 | 默认 | 说明 |
|----|------|------|
| 点击 | 420 | 按钮、选项 |
| 切 Tab | 1100 | 图文 / 视频 Tab |
| 跳转 | 1500 | 进入发布页 |
| 填表步骤 | 750 | 标题正文等；也缩放文本/图片等待 |
| 合集菜单 | 950 | 展开与选择 |
| 日历 | 700 | 定时日期时间 |
| 提交后 | 3400 | 暂存 / 定时发布完成 |
| 篇间隔 | 2600 | 自动化下一篇前 |

可在设置里逐项修改，或使用 **快速 / 稳健** 预设。填表偶发失败时调大「填表步骤」或「提交后」。

### 设置里的清理

- **清空发布标记**：去掉已导入标记，草稿和配图还在（需二次确认）
- **清空草稿列表**：清空本机列表后重新拉索引；令牌 / 仓库 / 路径不动

## 📦 数据约定

上游：[InfoFlow](https://github.com/shalom-lab/InfoFlow)

| 路径 | 用途 |
|------|------|
| `data/wechat_newspic_drafts.json` | 草稿索引 |
| `infoflow-data/Prompt/{id}.json` | 配图元数据（`image` / `images`） |
| `infoflow-data/Images/Prompt/` | 图片文件 |

索引字段：

| 字段 | 用途 |
|------|------|
| `id` | 草稿 ID，对应 Prompt / 配图 |
| `wechat_title` | 小红书标题 |
| `keywords` | 正文摘要与额外话题 |
| `reply_keyword` | 填入模板占位符 `{replyKeyword}` |

正文默认模板（设置里可改）：

```
🌈{keywords}
👉提示词获取方式：详见置顶笔记
✅回复口令：{replyKeyword}
{topics}
```

示例：

```
🌈像素风 · 8-bit
👉提示词获取方式：详见置顶笔记
✅回复口令：像素艺术
#图美AI #ChatGPT #美图提示词 #像素风
```

## 🛠️ 开发

```bash
npm run dev           # 开发构建
npm run build         # 类型检查 + 生产构建
npm run package       # 打包 release/*.zip
npm run sync-version  # 同步 package.json / manifest 版本
```

推送 semver tag（如 `v1.2.1`）会触发 GitHub Release zip，以及 Chrome Web Store 上传（需配置 Secrets）。

### 核心模块

- `src/sidepanel/` — 侧栏 UI
- `src/contents/publish-bridge.ts` — 发布页短消息桥（灌图 / 填文 / 暂存拆开）
- `src/lib/auto-upload.ts` — 单条流水线与 5 篇队列
- `src/lib/dom-inject.ts` — 标题、正文、合集、定时、提交按钮
- `src/lib/pace.ts` — 可配置停顿与预设
- `src/lib/compose.ts` / `src/lib/schedule.ts` — 正文话题与定时时间
- `src/lib/sync.ts` / `src/lib/github.ts` — 索引与配图
- `src/background/` — Service Worker、MAIN world 灌图

创作者页「暂存离开」在 `xhs-publish-btn` 的 closed shadow 里，扩展用 `chrome.dom.openOrClosedShadowRoot` 点白色按钮。

## 🔧 技术栈

- **Manifest V3** + `@crxjs/vite-plugin`
- **Vite** + **React** + **TypeScript**
- **IndexedDB** 本地缓存
- **GitHub Contents / Raw API**

## ⚠️ 注意

- **默认「存草稿」** 只点「暂存离开」；若选 **定时发布** 会点红色「定时发布」，不会点立即「发布」
- 自动化时请保持发布页打开；页面跳转后通道会断，扩展会等编辑态回来，不必刷新
- 小红书 DOM 常变，若填表失败，把控制台里 `[RedFlow]` 日志一并附上

## 🤝 贡献

欢迎提交 Issue 和 Pull Request。

## 🙏 致谢

- [InfoFlow](https://github.com/shalom-lab/InfoFlow) — 草稿与素材上游
- 所有贡献者和用户

---

<div align="center">

**如果这个项目对您有帮助，请给个 ⭐ Star！**

Made with ❤️ by [shalom-lab](https://github.com/shalom-lab)

</div>
