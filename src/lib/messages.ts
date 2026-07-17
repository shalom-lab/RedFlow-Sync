/** 扩展消息协议（Content Script ↔ Background） */

export type RedFlowRequest =
  | { type: "SYNC_NOW"; reason?: string }
  | { type: "GET_LOCAL_ITEMS"; category: string }
  | {
      type: "GET_IMAGE";
      category: string;
      fileId: string;
      /** 默认 thumb；full 为导入原图 */
      variant?: "thumb" | "full";
    }
  | {
      type: "FETCH_REMOTE_IMAGE";
      /** raw.githubusercontent.com 等已授权域名 */
      url: string;
    }
  | { type: "GET_SYNC_STATUS" };

export interface CachedItemDTO {
  fileId: string;
  category: string;
  title: string;
  body: string;
  imagePath: string;
  imageRawUrl: string;
  jsonPath: string;
  jsonSha: string;
  imageSha: string | null;
  updatedAt: string;
  hasImage: boolean;
  hasThumb: boolean;
}

export interface SyncStatusDTO {
  lastSyncAt: string | null;
  lastError: string | null;
  syncing: boolean;
  itemCount: number;
}

export type RedFlowResponse =
  | { ok: true; items: CachedItemDTO[]; status: SyncStatusDTO }
  | { ok: true; status: SyncStatusDTO; result?: SyncRunResult }
  | { ok: true; blob: ArrayBuffer; mime: string }
  | { ok: true; status: SyncStatusDTO }
  | { ok: false; error: string };

export interface SyncRunResult {
  categories: number;
  fetchedJson: number;
  fetchedImages: number;
  skipped: number;
  removed: number;
  durationMs: number;
}

export function sendRedFlow<T extends RedFlowResponse>(
  msg: RedFlowRequest,
): Promise<T> {
  return new Promise((resolve, reject) => {
    try {
      chrome.runtime.sendMessage(msg, (response) => {
        const err = chrome.runtime.lastError;
        if (err) {
          reject(new Error(err.message));
          return;
        }
        resolve((response ?? { ok: false, error: "无响应" }) as T);
      });
    } catch (e) {
      reject(e instanceof Error ? e : new Error(String(e)));
    }
  });
}
