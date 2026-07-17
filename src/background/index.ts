import { getConfig } from "@/lib/storage";
import { hasGitHubAccess } from "@/lib/permissions";
import {
  getImageArrayBuffer,
  getLocalItemsDto,
  getSyncStatusDto,
  isSyncing,
  runIncrementalSync,
  syncIfStale,
} from "@/lib/sync";
import type { RedFlowRequest, RedFlowResponse } from "@/lib/messages";

const ALARM_SYNC = "redflow-incremental-sync";
const SYNC_PERIOD_HOURS = 6;

/** 空缓存自动同步防抖：同一时间只触发一次 */
let emptyCacheKickoff: Promise<void> | null = null;

async function ensureAlarm(): Promise<void> {
  await chrome.alarms.create(ALARM_SYNC, {
    periodInMinutes: SYNC_PERIOD_HOURS * 60,
  });
}

async function safeSync(reason: string): Promise<RedFlowResponse> {
  try {
    const config = await getConfig();
    if (!config.owner || !config.repo) {
      return { ok: false, error: "尚未配置 GitHub 仓库" };
    }
    if (!(await hasGitHubAccess())) {
      return {
        ok: false,
        error:
          "尚未授权 GitHub。请到扩展 Options 页保存配置并允许访问。",
      };
    }
    const result = await runIncrementalSync(config);
    const status = await getSyncStatusDto();
    console.info(`[RedFlow] sync ok (${reason})`, result);
    return { ok: true, status, result };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    console.warn(`[RedFlow] sync fail (${reason})`, error);
    return { ok: false, error };
  }
}

function kickEmptyCacheSync(): void {
  if (isSyncing() || emptyCacheKickoff) return;
  emptyCacheKickoff = (async () => {
    await safeSync("empty-cache");
  })().finally(() => {
    emptyCacheKickoff = null;
  });
}

chrome.runtime.onInstalled.addListener((details) => {
  void ensureAlarm();
  if (details.reason === "install") {
    chrome.runtime.openOptionsPage();
  }
  if (details.reason === "install" || details.reason === "update") {
    void (async () => {
      const config = await getConfig();
      if (config.owner && config.repo) {
        await safeSync(details.reason);
      }
    })();
  }
});

chrome.runtime.onStartup.addListener(() => {
  void ensureAlarm();
  void (async () => {
    const config = await getConfig();
    if (config.owner && config.repo) {
      try {
        await syncIfStale(config);
      } catch (e) {
        console.warn("[RedFlow] startup stale sync", e);
      }
    }
  })();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== ALARM_SYNC) return;
  void safeSync("alarm");
});

chrome.runtime.onMessage.addListener(
  (message: RedFlowRequest, _sender, sendResponse) => {
    void (async () => {
      try {
        if (message.type === "SYNC_NOW") {
          sendResponse(await safeSync(message.reason ?? "manual"));
          return;
        }

        if (message.type === "GET_LOCAL_ITEMS") {
          const items = await getLocalItemsDto(message.category);
          const status = await getSyncStatusDto();

          if (!items.length) {
            const granted = await hasGitHubAccess();
            // 仅在从未成功同步过时自动拉一次，避免空分类反复全量 sync
            const neverSynced = !status.lastSyncAt;
            const canAutoSync =
              granted && neverSynced && !status.lastError;
            if (canAutoSync && !isSyncing()) {
              kickEmptyCacheSync();
            }
            sendResponse({
              ok: true,
              items: [],
              status: {
                ...status,
                syncing: isSyncing() || emptyCacheKickoff != null,
              },
            } satisfies RedFlowResponse);
            return;
          }

          sendResponse({
            ok: true,
            items,
            status,
          } satisfies RedFlowResponse);
          void (async () => {
            try {
              const config = await getConfig();
              await syncIfStale(config);
            } catch {
              /* ignore */
            }
          })();
          return;
        }

        if (message.type === "GET_IMAGE") {
          const data = await getImageArrayBuffer(
            message.category,
            message.fileId,
            message.variant ?? "thumb",
          );
          if (!data) {
            sendResponse({
              ok: false,
              error: "本地无图片缓存，请先点同步",
            } satisfies RedFlowResponse);
            return;
          }
          sendResponse({
            ok: true,
            blob: data.buffer,
            mime: data.mime,
          } satisfies RedFlowResponse);
          return;
        }

        if (message.type === "FETCH_REMOTE_IMAGE") {
          if (!(await hasGitHubAccess())) {
            sendResponse({
              ok: false,
              error: "尚未授权 GitHub，无法下载图片",
            } satisfies RedFlowResponse);
            return;
          }
          try {
            const res = await fetch(message.url, { cache: "no-cache" });
            if (!res.ok) {
              sendResponse({
                ok: false,
                error: `远程图片 HTTP ${res.status}`,
              } satisfies RedFlowResponse);
              return;
            }
            const blob = await res.blob();
            if (!blob.size) {
              sendResponse({
                ok: false,
                error: "远程图片为空",
              } satisfies RedFlowResponse);
              return;
            }
            const mime =
              blob.type && blob.type.startsWith("image/")
                ? blob.type
                : "image/png";
            sendResponse({
              ok: true,
              blob: await blob.arrayBuffer(),
              mime,
            } satisfies RedFlowResponse);
          } catch (e) {
            sendResponse({
              ok: false,
              error: e instanceof Error ? e.message : String(e),
            } satisfies RedFlowResponse);
          }
          return;
        }

        if (message.type === "GET_SYNC_STATUS") {
          sendResponse({
            ok: true,
            status: {
              ...(await getSyncStatusDto()),
              syncing: isSyncing() || emptyCacheKickoff != null,
            },
          } satisfies RedFlowResponse);
          return;
        }

        sendResponse({
          ok: false,
          error: "未知消息类型",
        } satisfies RedFlowResponse);
      } catch (e) {
        sendResponse({
          ok: false,
          error: e instanceof Error ? e.message : String(e),
        } satisfies RedFlowResponse);
      }
    })();
    return true;
  },
);

void ensureAlarm();
