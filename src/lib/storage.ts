import {
  DEFAULT_CONFIG,
  type ExtensionConfig,
  type UploadHistory,
} from "@/types";
import { itemKey } from "./keys";

const CONFIG_KEY = "redflow_config";
const HISTORY_KEY = "redflow_upload_history";

export async function getConfig(): Promise<ExtensionConfig> {
  const result = await chrome.storage.local.get(CONFIG_KEY);
  const merged: ExtensionConfig = {
    ...DEFAULT_CONFIG,
    ...(result[CONFIG_KEY] as ExtensionConfig | undefined),
  };
  // 旧配置可能存了空 basePath，回落到默认目录
  if (!merged.basePath?.trim()) {
    merged.basePath = DEFAULT_CONFIG.basePath;
  }
  return merged;
}

export async function saveConfig(config: ExtensionConfig): Promise<void> {
  const normalized: ExtensionConfig = {
    ...config,
    basePath: config.basePath.trim() || DEFAULT_CONFIG.basePath,
  };
  await chrome.storage.local.set({ [CONFIG_KEY]: normalized });
}

export async function getUploadHistory(): Promise<UploadHistory> {
  const result = await chrome.storage.local.get(HISTORY_KEY);
  return (result[HISTORY_KEY] as UploadHistory | undefined) ?? {};
}

export async function markUploaded(
  category: string,
  fileId: string,
): Promise<void> {
  const history = await getUploadHistory();
  const key = itemKey(category, fileId);
  history[key] = {
    uploaded: true,
    uploadedAt: new Date().toISOString(),
  };
  // 兼容旧版仅 fileId 的 key，顺带清理避免重复
  if (history[fileId]) delete history[fileId];
  await chrome.storage.local.set({ [HISTORY_KEY]: history });
}

export function isUploaded(
  history: UploadHistory,
  category: string,
  fileId: string,
): { uploaded: boolean; uploadedAt?: string } {
  const keyed = history[itemKey(category, fileId)];
  if (keyed?.uploaded) {
    return { uploaded: true, uploadedAt: keyed.uploadedAt };
  }
  // 兼容旧数据
  const legacy = history[fileId];
  if (legacy?.uploaded) {
    return { uploaded: true, uploadedAt: legacy.uploadedAt };
  }
  return { uploaded: false };
}

export async function clearUploadHistory(): Promise<void> {
  await chrome.storage.local.remove(HISTORY_KEY);
}

export function parseCategories(raw: string): string[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}
