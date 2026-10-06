/**
 * 把小红书发布页收到独立小窗，贴在工作区右侧。
 * 窗口保持可见（不最小化），自动化才能点到页面；但不抢整屏。
 */

const XHS_PUBLISH_URL =
  "https://creator.xiaohongshu.com/publish/publish?target=image";

/** 比用户参考截图再略小一档：侧栏 + 上传区勉强能点 */
export const COMPACT_PUBLISH_WIDTH = 800;
export const COMPACT_PUBLISH_HEIGHT = 620;
const EDGE_GAP = 12;
/** 已接近目标尺寸就不再反复挪窗，免得打断用户自己拖过的位置 */
const SIZE_SLACK_PX = 64;

export type WorkArea = {
  left: number;
  top: number;
  width: number;
  height: number;
};

export function getScreenWorkArea(): WorkArea {
  if (typeof screen !== "undefined") {
    const s = screen as Screen & { availLeft?: number; availTop?: number };
    return {
      left: Number(s.availLeft) || 0,
      top: Number(s.availTop) || 0,
      width: s.availWidth || 1920,
      height: s.availHeight || 1080,
    };
  }
  return { left: 0, top: 0, width: 1920, height: 1080 };
}

export function compactWindowBounds(work = getScreenWorkArea()): {
  left: number;
  top: number;
  width: number;
  height: number;
} {
  const width = Math.min(COMPACT_PUBLISH_WIDTH, Math.max(680, work.width - EDGE_GAP * 2));
  const height = Math.min(
    COMPACT_PUBLISH_HEIGHT,
    Math.max(500, work.height - EDGE_GAP * 2),
  );
  return {
    width,
    height,
    left: work.left + Math.max(EDGE_GAP, work.width - width - EDGE_GAP),
    top: work.top + Math.max(EDGE_GAP, Math.round((work.height - height) / 2)),
  };
}

function isAlreadyCompact(win: chrome.windows.Window): boolean {
  if (win.state === "minimized" || win.state === "maximized" || win.state === "fullscreen") {
    return false;
  }
  const w = win.width ?? 0;
  const h = win.height ?? 0;
  return (
    w > 0 &&
    h > 0 &&
    w <= COMPACT_PUBLISH_WIDTH + SIZE_SLACK_PX &&
    h <= COMPACT_PUBLISH_HEIGHT + SIZE_SLACK_PX
  );
}

async function applyCompactBounds(
  windowId: number,
  force: boolean,
): Promise<void> {
  const win = await chrome.windows.get(windowId);
  if (!force && isAlreadyCompact(win)) return;

  if (win.state && win.state !== "normal") {
    await chrome.windows.update(windowId, { state: "normal" });
  }
  const bounds = compactWindowBounds();
  await chrome.windows.update(windowId, {
    ...bounds,
    state: "normal",
    focused: force,
  });
}

/**
 * 确保 tab 落在右侧小窗里。force=true 时按默认尺寸重新贴边（勾选设置时用）。
 */
export async function dockPublishTabInCompactWindow(
  tabId: number,
  opts?: { force?: boolean },
): Promise<void> {
  const force = opts?.force === true;
  const tab = await chrome.tabs.get(tabId);
  if (tab.windowId == null) return;

  const siblings = await chrome.tabs.query({ windowId: tab.windowId });
  if (siblings.length === 1) {
    await applyCompactBounds(tab.windowId, force);
    return;
  }

  const bounds = compactWindowBounds();
  const created = await chrome.windows.create({
    tabId,
    type: "normal",
    focused: true,
    state: "normal",
    ...bounds,
  });
  if (created.id != null && !isAlreadyCompact(created)) {
    await applyCompactBounds(created.id, true);
  }
}

export async function openCompactPublishWindow(): Promise<
  { ok: true; tabId: number } | { ok: false; error: string }
> {
  const bounds = compactWindowBounds();
  const created = await chrome.windows.create({
    url: XHS_PUBLISH_URL,
    type: "normal",
    focused: true,
    state: "normal",
    ...bounds,
  });
  const tabId = created.tabs?.[0]?.id;
  if (tabId == null) {
    return { ok: false, error: "无法打开小红书发布小窗" };
  }
  return { ok: true, tabId };
}
