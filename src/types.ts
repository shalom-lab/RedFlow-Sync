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
  /** 侧栏打开且发布页在时，每天自动暂存 5 篇 */
  dailyAutoPublish: boolean;
}

/** 本地缓存使用的固定分类名（后续按 Prompt 配图仍挂在此分类下） */
export const DRAFTS_CATEGORY = "wechat_drafts";

export const DEFAULT_DRAFTS_FILE = "data/wechat_newspic_drafts.json";
/** Prompt 元数据：infoflow-data/Prompt/{id}.json */
export const DEFAULT_PROMPTS_PATH = "infoflow-data/Prompt";
/** 配图：infoflow-data/Images/Prompt/{图片id}.png */
export const DEFAULT_IMAGES_PATH = "infoflow-data/Images/Prompt";

export const DEFAULT_CONFIG: ExtensionConfig = {
  githubToken: "",
  owner: "shalom-lab",
  repo: "InfoFlow",
  branch: "master",
  basePath: DEFAULT_DRAFTS_FILE,
  imagesPath: DEFAULT_IMAGES_PATH,
  categories: "",
  dailyAutoPublish: false,
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
