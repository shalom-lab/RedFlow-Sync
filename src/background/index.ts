import { getConfig } from "@/lib/storage";
import { hasGitHubAccess } from "@/lib/permissions";
import {
  getImageArrayBuffer,
  getImagesArrayBuffers,
  getLocalItemsDto,
  getSyncStatusDto,
  isSyncing,
  runIncrementalSync,
  syncIfStale,
} from "@/lib/sync";
import { idbClearDraftIndex, idbClearUploadedFlags, idbMarkUploaded } from "@/lib/idb";
import { arrayBufferToBase64 } from "@/lib/base64";
import { clearDailyAutoDate, clearUploadHistory } from "@/lib/storage";
import type { RedFlowRequest, RedFlowResponse } from "@/lib/messages";
import {
  assembleUploadInputFromWindowB64,
  clickZancunLeaveInMainWorld,
  declareAiContentInMainWorld,
  muteGeolocationInMainWorld,
  selectGroupChatInMainWorld,
  selectPublishMenuInMainWorld,
  selectQuoteNoteFirstInMainWorld,
  writeWindowB64Chunk,
  WINDOW_B64_CHUNK,
  type MainWorldImageFile,
} from "@/lib/main-world-inject";

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
        error: "尚未授权 GitHub。请在侧栏「设置」保存配置并允许访问。",
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
  void chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((err) => console.warn("[RedFlow] sidePanel behavior", err));
  if (details.reason === "install" || details.reason === "update") {
    void (async () => {
      const config = await getConfig();
      if (config.owner && config.repo) {
        await safeSync(details.reason);
      }
    })();
  }
});

// 点击工具栏图标 → 打开 Side Panel（无 popup）
void chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((err) => console.warn("[RedFlow] sidePanel behavior", err));

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
  (
    message:
      | RedFlowRequest
      | { type: "MUTE_GEOLOCATION" }
      | { type: "MAIN_WORLD_CLICK_ZANCUN"; kind?: "draft" | "schedule" }
      | {
          type: "MAIN_WORLD_SELECT";
          kind: "collection" | "groupChat";
          name: string;
        }
      | { type: "MAIN_WORLD_DECLARE_AI" }
      | { type: "MAIN_WORLD_SELECT_GROUP"; name?: string }
      | { type: "MAIN_WORLD_SELECT_QUOTE_NOTE" }
      | {
          type: "INJECT_IMAGE_FILES";
          files?: MainWorldImageFile[];
          category?: string;
          fileId?: string;
        },
    _sender,
    sendResponse,
  ) => {
    if (message && typeof message === "object" && message.type === "INJECT_IMAGE_FILES") {
      const tabId = _sender.tab?.id;
      void (async () => {
        try {
          if (tabId == null) {
            sendResponse({ ok: false, error: "no tab" });
            return;
          }

          let files = message.files;
          if (message.category && message.fileId) {
            const raw = await getImagesArrayBuffers(
              message.category,
              message.fileId,
            );
            files = raw.map((b, i) => {
              const mime = b.mime && b.mime.startsWith("image/") ? b.mime : "image/png";
              const ext = mime.includes("jpeg") || mime.includes("jpg") ? "jpg" : "png";
              return {
                name: `${message.fileId}-${i + 1}.${ext}`,
                type: mime,
                base64: arrayBufferToBase64(b.buffer),
              };
            });
          }

          if (!files?.length) {
            sendResponse({ ok: false, error: "无图片数据" });
            return;
          }

          await chrome.scripting.executeScript({
            target: { tabId },
            world: "MAIN",
            func: muteGeolocationInMainWorld,
          });

          // 1) 分块写入 window.__b64_0, __b64_1, ...（WorkBuddy chunk_and_send）
          for (let i = 0; i < files.length; i++) {
            const b64 = files[i].base64 || "";
            let offset = 0;
            let first = true;
            while (offset < b64.length) {
              const chunk = b64.slice(offset, offset + WINDOW_B64_CHUNK);
              await chrome.scripting.executeScript({
                target: { tabId },
                world: "MAIN",
                func: writeWindowB64Chunk,
                args: [i, chunk, !first],
              });
              first = false;
              offset += WINDOW_B64_CHUNK;
            }
          }

          // 2) 页面内 atob 组装 File，赋给 input.upload-input
          const [{ result }] = await chrome.scripting.executeScript({
            target: { tabId },
            world: "MAIN",
            func: assembleUploadInputFromWindowB64,
            args: [files.map((f) => f.name), files.map((f) => f.type)],
          });
          sendResponse(result ?? { ok: false, error: "MAIN inject 无返回" });
        } catch (e) {
          sendResponse({
            ok: false,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      })();
      return true;
    }

    if (message && typeof message === "object" && message.type === "MAIN_WORLD_SELECT") {
      const tabId = _sender.tab?.id;
      void (async () => {
        try {
          if (tabId == null) {
            sendResponse({ ok: false, error: "no tab" });
            return;
          }
          const [{ result }] = await chrome.scripting.executeScript({
            target: { tabId },
            world: "MAIN",
            func: selectPublishMenuInMainWorld,
            args: [message.kind, message.name],
          });
          sendResponse(result ?? { ok: false, error: "MAIN select 无返回" });
        } catch (e) {
          sendResponse({
            ok: false,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      })();
      return true;
    }

    if (message && typeof message === "object" && message.type === "MAIN_WORLD_DECLARE_AI") {
      const tabId = _sender.tab?.id;
      void (async () => {
        try {
          if (tabId == null) {
            sendResponse({ ok: false, error: "no tab" });
            return;
          }
          const [{ result }] = await chrome.scripting.executeScript({
            target: { tabId },
            world: "MAIN",
            func: declareAiContentInMainWorld,
          });
          sendResponse(result ?? { ok: false, error: "MAIN AI 声明无返回" });
        } catch (e) {
          sendResponse({
            ok: false,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      })();
      return true;
    }

    if (message && typeof message === "object" && message.type === "MAIN_WORLD_SELECT_GROUP") {
      const tabId = _sender.tab?.id;
      void (async () => {
        try {
          if (tabId == null) {
            sendResponse({ ok: false, error: "no tab" });
            return;
          }
          const [{ result }] = await chrome.scripting.executeScript({
            target: { tabId },
            world: "MAIN",
            func: selectGroupChatInMainWorld,
            args: [message.name ?? ""],
          });
          sendResponse(result ?? { ok: false, error: "MAIN 群聊选择无返回" });
        } catch (e) {
          sendResponse({
            ok: false,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      })();
      return true;
    }

    if (message && typeof message === "object" && message.type === "MAIN_WORLD_SELECT_QUOTE_NOTE") {
      const tabId = _sender.tab?.id;
      void (async () => {
        try {
          if (tabId == null) {
            sendResponse({ ok: false, error: "no tab" });
            return;
          }
          const [{ result }] = await chrome.scripting.executeScript({
            target: { tabId },
            world: "MAIN",
            func: selectQuoteNoteFirstInMainWorld,
          });
          sendResponse(result ?? { ok: false, error: "MAIN 引用笔记无返回" });
        } catch (e) {
          sendResponse({
            ok: false,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      })();
      return true;
    }

    if (message && typeof message === "object" && message.type === "MAIN_WORLD_CLICK_ZANCUN") {
      const tabId = _sender.tab?.id;
      void (async () => {
        try {
          if (tabId == null) {
            sendResponse({ ok: false, error: "no tab" });
            return;
          }
          const [{ result }] = await chrome.scripting.executeScript({
            target: { tabId },
            world: "MAIN",
            func: clickZancunLeaveInMainWorld,
            args: [message.kind === "schedule" ? "schedule" : "draft"],
          });
          sendResponse(result ?? { ok: false, error: "MAIN 暂存点击无返回" });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          if (
            msg.includes("back/forward cache") ||
            msg.includes("frame was removed") ||
            msg.includes("No tab with id")
          ) {
            sendResponse({ ok: true, navigated: true });
            return;
          }
          sendResponse({ ok: false, error: msg });
        }
      })();
      return true;
    }

    if (message && typeof message === "object" && message.type === "MUTE_GEOLOCATION") {
      const tabId = _sender.tab?.id;
      void (async () => {
        try {
          if (tabId == null) {
            sendResponse({ ok: false, error: "no tab" });
            return;
          }
          await chrome.scripting.executeScript({
            target: { tabId },
            world: "MAIN",
            func: muteGeolocationInMainWorld,
          });
          sendResponse({ ok: true });
        } catch (e) {
          sendResponse({
            ok: false,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      })();
      return true;
    }

    let replied = false;
    const reply = (res: RedFlowResponse) => {
      if (replied) return;
      replied = true;
      try {
        sendResponse(res);
      } catch {
        /* channel closed */
      }
    };

    void (async () => {
      try {
        if ((message as RedFlowRequest).type === "SYNC_NOW") {
          reply(
            await safeSync(
              (message as { reason?: string }).reason ?? "manual",
            ),
          );
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
            reply({
              ok: true,
              items: [],
              status: {
                ...status,
                syncing: isSyncing() || emptyCacheKickoff != null,
              },
            } satisfies RedFlowResponse);
            return;
          }

          reply({
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
            reply({
              ok: false,
              error: "暂无配图。导入时会读 infoflow-data/Prompt/{id}.json 的 image/images",
            } satisfies RedFlowResponse);
            return;
          }
          reply({
            ok: true,
            blob: arrayBufferToBase64(data.buffer),
            mime: data.mime,
            bytes: data.buffer.byteLength,
          } satisfies RedFlowResponse);
          return;
        }

        if (message.type === "GET_IMAGES") {
          try {
            const blobs = await getImagesArrayBuffers(
              message.category,
              message.fileId,
            );
            if (!blobs.length) {
              reply({
                ok: false,
                error: `未找到配图：请确认 infoflow-data/Prompt/${message.fileId}.json 与 image/images 对应的 infoflow-data/Images/Prompt/{图片id}.png`,
              } satisfies RedFlowResponse);
              return;
            }
            reply({
              ok: true,
              blobs: blobs.map((b) => ({
                base64: arrayBufferToBase64(b.buffer),
                mime: b.mime,
                bytes: b.buffer.byteLength,
              })),
            } satisfies RedFlowResponse);
          } catch (e) {
            reply({
              ok: false,
              error: e instanceof Error ? e.message : String(e),
            } satisfies RedFlowResponse);
          }
          return;
        }

        if (message.type === "FETCH_REMOTE_IMAGE") {
          if (!(await hasGitHubAccess())) {
            reply({
              ok: false,
              error: "尚未授权 GitHub，无法下载图片",
            } satisfies RedFlowResponse);
            return;
          }
          try {
            const res = await fetch(message.url, { cache: "no-cache" });
            if (!res.ok) {
              reply({
                ok: false,
                error: `远程图片 HTTP ${res.status}`,
              } satisfies RedFlowResponse);
              return;
            }
            const blob = await res.blob();
            if (!blob.size) {
              reply({
                ok: false,
                error: "远程图片为空",
              } satisfies RedFlowResponse);
              return;
            }
            const buf = await blob.arrayBuffer();
            const mime =
              blob.type && blob.type.startsWith("image/")
                ? blob.type
                : "image/png";
            reply({
              ok: true,
              blob: arrayBufferToBase64(buf),
              mime,
              bytes: buf.byteLength,
            } satisfies RedFlowResponse);
          } catch (e) {
            reply({
              ok: false,
              error: e instanceof Error ? e.message : String(e),
            } satisfies RedFlowResponse);
          }
          return;
        }

        if (message.type === "GET_SYNC_STATUS") {
          reply({
            ok: true,
            status: {
              ...(await getSyncStatusDto()),
              syncing: isSyncing() || emptyCacheKickoff != null,
            },
          } satisfies RedFlowResponse);
          return;
        }

        if (message.type === "MARK_UPLOADED") {
          const row = await idbMarkUploaded(message.category, message.fileId);
          if (!row) {
            reply({
              ok: false,
              error: "本地无此草稿，无法标记已上传",
            } satisfies RedFlowResponse);
            return;
          }
          // 配图留在 IndexedDB，历史页可点开查看
          reply({
            ok: true,
            status: await getSyncStatusDto(),
          } satisfies RedFlowResponse);
          return;
        }

        if (message.type === "CLEAR_UPLOADED") {
          await idbClearUploadedFlags();
          reply({
            ok: true,
            status: await getSyncStatusDto(),
          } satisfies RedFlowResponse);
          return;
        }

        if (message.type === "WIPE_ALL_DATA") {
          await idbClearDraftIndex();
          await clearUploadHistory();
          await clearDailyAutoDate();
          reply({
            ok: true,
            status: await getSyncStatusDto(),
          } satisfies RedFlowResponse);
          return;
        }

        reply({
          ok: false,
          error: "未知消息类型",
        } satisfies RedFlowResponse);
      } catch (e) {
        reply({
          ok: false,
          error: e instanceof Error ? e.message : String(e),
        } satisfies RedFlowResponse);
      }
    })();
    return true;
  },
);

void ensureAlarm();
