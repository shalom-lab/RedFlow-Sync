/** 向当前活动标签页的发布页 Content Script 发填入指令 */
import type {
  FillPublishPageRequest,
  FillPublishPageResponse,
  PublishPhase,
  UploadImagesRequest,
} from "@/contents/publish-bridge";
import { pace, sleep, waitPace } from "./pace";

export const XHS_PUBLISH_URL =
  "https://creator.xiaohongshu.com/publish/publish?target=image";

/** 侧栏打开时：发布页是否已经在。不自动新建标签。 */
export async function hasPublishTabOpen(): Promise<boolean> {
  const tabs = await chrome.tabs.query({
    url: ["*://creator.xiaohongshu.com/*"],
  });
  return tabs.some((t) => (t.url || "").includes("/publish"));
}

function isPortClosedError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return (
    msg.includes("back/forward cache") ||
    msg.includes("message channel") ||
    msg.includes("Receiving end does not exist") ||
    msg.includes("Extension context invalidated")
  );
}

async function findCreatorTabId(): Promise<number | null> {
  const creatorTabs = await chrome.tabs.query({
    url: ["*://creator.xiaohongshu.com/*"],
  });
  const publish = creatorTabs.find((t) =>
    (t.url || "").includes("/publish"),
  );
  if (publish?.id != null) return publish.id;

  const [active] = await chrome.tabs.query({
    active: true,
    currentWindow: true,
  });
  return active?.id ?? null;
}

function isOnPublishArea(url: string): boolean {
  return (
    url.includes("creator.xiaohongshu.com") && url.includes("/publish")
  );
}

type PingResult = { ok: true; phase: PublishPhase } | { ok: false };

async function pingPublish(tabId: number): Promise<PingResult> {
  try {
    const pong = await chrome.tabs.sendMessage(tabId, { type: "PING_PUBLISH" });
    if (pong?.ok) {
      return { ok: true, phase: (pong.phase as PublishPhase) || "unknown" };
    }
  } catch {
    /* script not ready */
  }
  return { ok: false };
}

export async function waitForPublishPhase(
  tabId: number,
  want: PublishPhase | PublishPhase[],
  timeoutMs: number,
): Promise<{ ok: true; phase: PublishPhase } | { ok: false; error: string }> {
  const wants = new Set(Array.isArray(want) ? want : [want]);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const pong = await pingPublish(tabId);
    if (pong.ok && wants.has(pong.phase)) {
      return { ok: true, phase: pong.phase };
    }
    await sleep(400);
  }
  return {
    ok: false,
    error: "发布页未进入预期状态。请保持发布页打开（不必刷新）后再试",
  };
}

/**
 * 确保发布页打开且 content script 就绪。
 * 已在 /publish 上就不再 tabs.update(url)，避免整页刷新掐断通信。
 */
export async function ensurePublishTabReady(): Promise<
  { ok: true; tabId: number } | { ok: false; error: string }
> {
  let tabId = await findCreatorTabId();
  if (tabId == null) {
    const created = await chrome.tabs.create({
      url: XHS_PUBLISH_URL,
      active: true,
    });
    if (created.id == null) {
      return { ok: false, error: "无法打开小红书发布页" };
    }
    tabId = created.id;
  } else {
    const tab = await chrome.tabs.get(tabId);
    const url = tab.url || "";
    await chrome.tabs.update(tabId, { active: true });
    if (!isOnPublishArea(url)) {
      await chrome.tabs.update(tabId, { url: XHS_PUBLISH_URL, active: true });
    }
  }

  for (let i = 0; i < 50; i++) {
    const pong = await pingPublish(tabId);
    if (pong.ok) return { ok: true, tabId };
    await sleep(400);
  }
  return {
    ok: false,
    error: "发布页脚本未就绪。请保持发布页在前台（不必手动刷新）后再试",
  };
}

type PublishCallResult = FillPublishPageResponse & { portClosed?: boolean };

async function sendToPublish(
  tabId: number,
  message: object,
): Promise<PublishCallResult> {
  try {
    const res = (await chrome.tabs.sendMessage(
      tabId,
      message,
    )) as FillPublishPageResponse | undefined;
    if (!res) {
      return { ok: false, error: "发布页无响应" };
    }
    return res;
  } catch (e) {
    if (isPortClosedError(e)) {
      return { ok: false, error: "port-closed", portClosed: true };
    }
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

async function recoverPublishTab(tabId: number): Promise<boolean> {
  await chrome.tabs.update(tabId, { url: XHS_PUBLISH_URL, active: true });
  const ready = await waitForPublishPhase(tabId, ["upload", "edit"], 20000);
  return ready.ok;
}

/** 暂存后等落地页回来。尽量不刷新；实在卡住才回发布 URL 一次。 */
export async function settleAfterZancun(tabId: number): Promise<void> {
  await waitPace("settle");
  const back = await waitForPublishPhase(tabId, "upload", 18000);
  if (back.ok) return;

  const prep = await sendToPublish(tabId, { type: "PREPARE_PUBLISH" });
  if (prep.portClosed) {
    const afterNav = await waitForPublishPhase(tabId, "upload", 12000);
    if (afterNav.ok) return;
  } else if (prep.ok) {
    const afterPrep = await waitForPublishPhase(tabId, "upload", 10000);
    if (afterPrep.ok) return;
  }

  await recoverPublishTab(tabId);
}

export async function fillPublishOnActiveTab(
  payload: Omit<FillPublishPageRequest, "type">,
): Promise<FillPublishPageResponse & { tabId?: number }> {
  const ready = await ensurePublishTabReady();
  if (!ready.ok) {
    return { ok: false, error: ready.error };
  }
  const tabId = ready.tabId;

  const prep = await sendToPublish(tabId, { type: "PREPARE_PUBLISH" });
  if (prep.portClosed) {
    const after = await waitForPublishPhase(tabId, ["upload", "edit"], 15000);
    if (!after.ok) {
      return { ok: false, error: after.error, tabId };
    }
  } else if (!prep.ok) {
    return { ok: false, error: prep.error, tabId };
  }

  const uploadMsg: UploadImagesRequest = {
    type: "UPLOAD_IMAGES",
    category: payload.category,
    fileId: payload.fileId,
    imageRawUrl: payload.imageRawUrl,
  };
  const uploaded = await sendToPublish(tabId, uploadMsg);
  if (uploaded.portClosed) {
    // 灌图后页面跳编辑态是常态，通道关掉不算失败
  } else if (!uploaded.ok) {
    return { ...uploaded, tabId };
  }

  const edit = await waitForPublishPhase(tabId, "edit", 45000);
  if (!edit.ok) {
    return {
      ok: false,
      error: "图片上传后未进入编辑页。请保持发布页打开（不必刷新）后重试。",
      tabId,
    };
  }
  await sleep(pace("step"));

  const fillMsg: FillPublishPageRequest = { type: "FILL_TEXT", ...payload };
  let filled = await sendToPublish(tabId, fillMsg);
  if (filled.portClosed) {
    const stillEdit = await waitForPublishPhase(tabId, "edit", 12000);
    if (stillEdit.ok) {
      filled = await sendToPublish(tabId, fillMsg);
    }
  }

  if (filled.portClosed) {
    return {
      ok: false,
      error: "填表时发布页跳转了。请保持发布页在前台后重试（不必刷新）。",
      tabId,
    };
  }

  return { ...filled, tabId };
}

export async function clickFooterOnTab(
  tabId: number,
  kind: "draft" | "schedule" = "draft",
): Promise<boolean> {
  try {
    const res = (await chrome.tabs.sendMessage(tabId, {
      type: "CLICK_FOOTER",
      kind,
    })) as { ok?: boolean } | undefined;
    return Boolean(res?.ok);
  } catch (e) {
    if (isPortClosedError(e)) return true;
    console.warn("[RedFlow] CLICK_FOOTER", e);
    return false;
  }
}

/** @deprecated 使用 clickFooterOnTab(tabId, "draft") */
export async function clickZancunOnTab(tabId: number): Promise<boolean> {
  return clickFooterOnTab(tabId, "draft");
}
