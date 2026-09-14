/** GitHub / 插件配置（Options / Popup 持久化） */
export interface ExtensionConfig {
  githubToken: string;
  owner: string;
  repo: string;
  branch: string;
  basePath: string;
  /** 英文逗号分隔，如 "ai,food,travel" */
  categories: string;
}

export const DEFAULT_CONFIG: ExtensionConfig = {
  githubToken: "",
  owner: "",
  repo: "",
  branch: "main",
  basePath: "infoflow-data",
  categories: "",
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

/** InfoFlow Picker JSON 字段（宽松兼容） */
export interface InfoFlowJson {
  content?: string;
  notes?: string;
  image?: string;
  title?: string;
  [key: string]: unknown;
}

export interface ContentItem {
  fileId: string;
  category: string;
  title: string;
  body: string;
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
