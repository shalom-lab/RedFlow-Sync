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
  basePath: "",
  categories: "",
};

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
