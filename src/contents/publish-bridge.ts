/**
 * 发布页 Content Script：只负责 DOM 注入桥接。
 * UI 在 chrome.sidePanel 中，不在此挂载。
 *
 * 灌图、填文、暂存必须拆成短消息。
 * 灌图后页面常会跳到编辑态；同一次 tabs 消息里死等会掐断通道。
 */
import {
  clickZancunLeave,
  detectPublishPhase,
  fillPublishText,
  preparePublishLanding,
  uploadPublishImages,
  waitForPublishForm,
  type PublishPhase,
} from "@/lib/dom-inject";
import { sendRedFlow } from "@/lib/messages";
import { base64ToBlob } from "@/lib/base64";

export type { PublishPhase };

export type FillPublishPageRequest = {
  type: "FILL_PUBLISH" | "FILL_TEXT";
  category: string;
  fileId: string;
  title: string;
  body: string;
  imageRawUrl?: string;
  topics?: string[];
  collectionName?: string;
  groupChatName?: string;
  scheduledAt?: string;
};

export type UploadImagesRequest = {
  type: "UPLOAD_IMAGES";
  category: string;
  fileId: string;
  imageRawUrl?: string;
};

export type FillPublishPageResponse = {
  ok: boolean;
  error?: string;
  phase?: PublishPhase;
  steps?: {
    title: boolean;
    body: boolean;
    image: boolean;
    draftSaved?: boolean;
    collection?: boolean;
    groupChat?: boolean;
    topics?: boolean;
    scheduled?: boolean;
    scheduledAt?: string;
  };
  hadImage?: boolean;
  /** 填表成功，侧栏应另发 CLICK_ZANCUN */
  draftPending?: boolean;
};

async function loadImageBlobs(msg: {
  category: string;
  fileId: string;
  imageRawUrl?: string;
}): Promise<{ blobs?: Blob[]; error?: string }> {
  const imgsRes = await sendRedFlow({
    type: "GET_IMAGES",
    category: msg.category,
    fileId: msg.fileId,
  });

  if (imgsRes.ok && "blobs" in imgsRes && imgsRes.blobs.length) {
    return {
      blobs: imgsRes.blobs.map((b) =>
        base64ToBlob(b.base64, b.mime || "image/png"),
      ),
    };
  }

  if (msg.imageRawUrl) {
    const remote = await sendRedFlow({
      type: "FETCH_REMOTE_IMAGE",
      url: msg.imageRawUrl,
    });
    if (remote.ok && "blob" in remote) {
      return {
        blobs: [base64ToBlob(remote.blob, remote.mime || "image/png")],
      };
    }
  }

  return {
    error:
      imgsRes.ok === false
        ? imgsRes.error
        : `未找到配图。请确认 infoflow-data/Prompt/${msg.fileId}.json 与 Images/Prompt 下对应图片`,
  };
}

async function handleUpload(
  msg: UploadImagesRequest,
): Promise<FillPublishPageResponse> {
  const ready = await waitForPublishForm(15000);
  if (!ready) {
    return { ok: false, error: "发布表单尚未就绪，请确认在「上传图文」页" };
  }

  const loaded = await loadImageBlobs(msg);
  if (!loaded.blobs?.length) {
    return { ok: false, error: loaded.error, hadImage: false };
  }

  const result = await uploadPublishImages({
    fileId: msg.fileId,
    category: msg.category,
    imageBlob: loaded.blobs,
  });

  return {
    ok: result.ok,
    error: result.error,
    hadImage: result.ok,
    phase: detectPublishPhase(),
    steps: {
      title: false,
      body: false,
      image: Boolean(result.ok),
    },
  };
}

async function handleFillText(
  msg: FillPublishPageRequest,
): Promise<FillPublishPageResponse> {
  const result = await fillPublishText({
    title: msg.title,
    body: msg.body,
    topics: msg.topics,
    collectionName: msg.collectionName,
    scheduledAt: msg.scheduledAt,
  });

  return {
    ok: result.ok,
    error: result.error,
    phase: detectPublishPhase(),
    steps: {
      title: result.title,
      body: result.body,
      image: true,
      draftSaved: false,
      collection: result.collection,
      groupChat: result.groupChat,
      topics: result.topics,
      scheduled: result.scheduled,
      scheduledAt: result.scheduledAt,
    },
    hadImage: true,
    draftPending: Boolean(result.ok && result.title && result.body),
  };
}

function isChannelGoneError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return (
    msg.includes("back/forward cache") ||
    msg.includes("message channel") ||
    msg.includes("Extension context invalidated")
  );
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message !== "object") return false;

  const type = (message as { type?: string }).type;

  if (type === "PING_PUBLISH") {
    sendResponse({ ok: true, phase: detectPublishPhase() });
    return false;
  }

  if (type === "PREPARE_PUBLISH") {
    void preparePublishLanding()
      .then((res) => sendResponse(res))
      .catch((e) =>
        sendResponse({
          ok: false,
          phase: detectPublishPhase(),
          error: e instanceof Error ? e.message : String(e),
        }),
      );
    return true;
  }

  if (type === "CLICK_ZANCUN") {
    void clickZancunLeave()
      .then((ok) => {
        try {
          sendResponse({ ok, started: true });
        } catch {
          /* 点完后页面可能已跳转，通道关掉视为已点到 */
        }
      })
      .catch((e) => {
        if (!isChannelGoneError(e)) {
          console.warn("[RedFlow] 暂存离开点击失败", e);
        }
        try {
          sendResponse({
            ok: isChannelGoneError(e),
            error: e instanceof Error ? e.message : String(e),
          });
        } catch {
          /* ignore */
        }
      });
    return true;
  }

  if (type === "UPLOAD_IMAGES") {
    void handleUpload(message as UploadImagesRequest)
      .then((res) => sendResponse(res))
      .catch((e) =>
        sendResponse({
          ok: false,
          error: e instanceof Error ? e.message : String(e),
        }),
      );
    return true;
  }

  if (type === "FILL_TEXT" || type === "FILL_PUBLISH") {
    void handleFillText(message as FillPublishPageRequest)
      .then((res) => sendResponse(res))
      .catch((e) =>
        sendResponse({
          ok: false,
          error: e instanceof Error ? e.message : String(e),
        }),
      );
    return true;
  }

  return false;
});
