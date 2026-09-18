/** 自动化各步停顿种类（毫秒） */
export type PaceKind =
  | "click"
  | "tab"
  | "nav"
  | "step"
  | "menu"
  | "calendar"
  | "settle"
  | "betweenDrafts";

export type PaceConfig = Record<PaceKind, number>;

export const DEFAULT_PACE_MS: PaceConfig = {
  click: 420,
  tab: 1100,
  nav: 1500,
  step: 750,
  menu: 950,
  calendar: 700,
  settle: 3400,
  betweenDrafts: 2600,
};

/** GitHub / 插件配置（Options / Popup 持久化） */
export interface ExtensionConfig {
  githubToken: string;
  owner: string;
  repo: string;
  branch: string;
  /**
   * 草稿索引文件路径（相对仓库根）
   * 默认：data/wechat_newspic_drafts.json
   */
  basePath: string;
  /**
   * 配图目录（相对仓库根），默认 infoflow-data/Images/Prompt。
   * 导入时先读同级 Prompt/{id}.json 的 image/images，再按文件名取图。
   */
  imagesPath: string;
  /** 保留字段；当前草稿同步不依赖分类 */
  categories: string;
  /** 侧栏打开且发布页在时，每天自动处理 5 篇 */
  dailyAutoPublish: boolean;
  /**
   * 提交方式：
   * - draft：不勾选页面「定时发布」，点白色「暂存离开」存草稿
   * - schedule：勾选并填写定时后，点红色「定时发布」
   */
  submitMode: "draft" | "schedule";
  /** 定时可发时段开始小时 0–23 */
  scheduleStartHour: number;
  /** 定时可发时段结束小时 0–23 */
  scheduleEndHour: number;
  /** 最早距现在多少小时 */
  scheduleMinLeadHours: number;
  /** 最多提前多少天（页面日历大约 14 天） */
  scheduleMaxAheadDays: number;
  /** 各步停顿（毫秒），默认见 DEFAULT_PACE_MS */
  pace: PaceConfig;
  /** 填表时在「添加内容类型声明」里选「笔记含AI合成内容」 */
  declareAiContent: boolean;
  /** 加入合集名称（按名字匹配） */
  collectionName: string;
  /** 是否选择群聊 */
  groupChatEnabled: boolean;
  /** 群聊名称；空则点列表第一项 */
  groupChatName: string;
  /** 是否引用笔记（默认点「我的笔记」第一项） */
  quoteNoteEnabled: boolean;
  /**
   * 正文必加话题（逗号/空格分隔），默认：图美AI,ChatGPT,AI作图提示词
   * 会与草稿 keywords 合并去重
   */
  requiredTopics: string;
}

/** 本地缓存使用的固定分类名（后续按 Prompt 配图仍挂在此分类下） */
export const DRAFTS_CATEGORY = "wechat_drafts";

export const DEFAULT_DRAFTS_FILE = "data/wechat_newspic_drafts.json";
/** Prompt 元数据：infoflow-data/Prompt/{id}.json */
export const DEFAULT_PROMPTS_PATH = "infoflow-data/Prompt";
/** 配图：infoflow-data/Images/Prompt/{图片id}.png */
export const DEFAULT_IMAGES_PATH = "infoflow-data/Images/Prompt";

export const DEFAULT_COLLECTION_NAME = "ChatGPT美图";
export const DEFAULT_REQUIRED_TOPICS = "图美AI,ChatGPT,AI作图提示词";

export const DEFAULT_CONFIG: ExtensionConfig = {
  githubToken: "",
  owner: "shalom-lab",
  repo: "InfoFlow",
  branch: "master",
  basePath: DEFAULT_DRAFTS_FILE,
  imagesPath: DEFAULT_IMAGES_PATH,
  categories: "",
  dailyAutoPublish: false,
  submitMode: "draft",
  scheduleStartHour: 10,
  scheduleEndHour: 20,
  scheduleMinLeadHours: 2,
  scheduleMaxAheadDays: 14,
  pace: { ...DEFAULT_PACE_MS },
  declareAiContent: true,
  collectionName: DEFAULT_COLLECTION_NAME,
  groupChatEnabled: false,
  groupChatName: "",
  quoteNoteEnabled: false,
  requiredTopics: DEFAULT_REQUIRED_TOPICS,
};

/** UI 用：`owner/repo`；也接受完整 GitHub URL */
export function formatRepoSlug(owner: string, repo: string): string {
  const o = owner.trim();
  const r = repo.trim();
  if (!o && !r) return "";
  return `${o}/${r}`;
}

export function parseRepoSlug(input: string): { owner: string; repo: string } | null {
  let raw = input.trim();
  if (!raw) return null;

  raw = raw
    .replace(/^https?:\/\/github\.com\//i, "")
    .replace(/\.git$/i, "")
    .replace(/\/+$/, "");

  const parts = raw.split("/").map((s) => s.trim()).filter(Boolean);
  if (parts.length < 2) return null;

  return { owner: parts[0], repo: parts[1] };
}

/** 已上传记录 */
export interface UploadHistory {
  [fileId: string]: {
    uploaded: boolean;
    uploadedAt: string;
  };
}

/** InfoFlow `wechat_newspic_drafts.json` 条目（只保留同步所需字段） */
export interface WechatDraftItem {
  id: string;
  wechat_title: string;
  keywords: string[];
  reply_keyword: string;
}

export interface ContentItem {
  fileId: string;
  category: string;
  title: string;
  body: string;
  keywords: string[];
  replyKeyword: string;
  imagePath: string;
  imageRawUrl: string;
  thumbnailUrl: string;
  jsonPath: string;
  uploaded: boolean;
  uploadedAt?: string;
}

export interface FillResult {
  ok: boolean;
  fileId: string;
  steps: {
    title: boolean;
    body: boolean;
    image: boolean;
  };
  error?: string;
}
