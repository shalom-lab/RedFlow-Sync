/** 按操作难度停顿，避免小红书 DOM 还没稳住就点下一步 */

import {
  DEFAULT_PACE_MS,
  type ExtensionConfig,
  type PaceConfig,
  type PaceKind,
} from "@/types";

export { DEFAULT_PACE_MS };
export type { PaceConfig, PaceKind };

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export const PACE_FIELDS: Array<{ key: PaceKind; label: string; hint?: string }> =
  [
    { key: "click", label: "点击", hint: "按钮、选项" },
    { key: "tab", label: "切 Tab", hint: "图文 / 视频 Tab" },
    { key: "nav", label: "跳转", hint: "进入发布页" },
    { key: "step", label: "填表步骤", hint: "标题正文等；也缩放文本/图片等待" },
    { key: "menu", label: "合集菜单", hint: "展开与选择" },
    { key: "calendar", label: "日历", hint: "定时日期时间" },
    { key: "settle", label: "提交后", hint: "暂存 / 定时发布完成" },
    { key: "betweenDrafts", label: "篇间隔", hint: "自动化下一篇前" },
  ];

export const PACE_PRESETS: Array<{
  id: "default" | "fast" | "safe";
  label: string;
  pace: PaceConfig;
}> = [
  { id: "default", label: "默认", pace: DEFAULT_PACE_MS },
  {
    id: "fast",
    label: "快速",
    pace: {
      click: 220,
      tab: 650,
      nav: 900,
      step: 420,
      menu: 520,
      calendar: 400,
      settle: 1800,
      betweenDrafts: 1400,
    },
  },
  {
    id: "safe",
    label: "稳健",
    pace: {
      click: 620,
      tab: 1500,
      nav: 2200,
      step: 1100,
      menu: 1300,
      calendar: 950,
      settle: 4800,
      betweenDrafts: 3600,
    },
  },
];

function clampPace(n: unknown, fallback: number): number {
  const v = typeof n === "number" ? n : Number(n);
  if (!Number.isFinite(v)) return fallback;
  return Math.min(20000, Math.max(50, Math.round(v)));
}

export function normalizePace(raw?: Partial<PaceConfig> | null): PaceConfig {
  const out = { ...DEFAULT_PACE_MS };
  for (const key of Object.keys(DEFAULT_PACE_MS) as PaceKind[]) {
    out[key] = clampPace(raw?.[key], DEFAULT_PACE_MS[key]);
  }
  return out;
}

let currentPace: PaceConfig = { ...DEFAULT_PACE_MS };
let loadPromise: Promise<void> | null = null;

export function applyPaceConfig(
  cfg?: Partial<Pick<ExtensionConfig, "pace">> | null,
): void {
  currentPace = normalizePace(cfg?.pace);
}

export async function ensurePaceLoaded(): Promise<void> {
  if (loadPromise) {
    await loadPromise;
    return;
  }
  loadPromise = (async () => {
    try {
      const { getConfig } = await import("./storage");
      applyPaceConfig(await getConfig());
    } catch {
      currentPace = { ...DEFAULT_PACE_MS };
    }
  })();
  await loadPromise;
}

if (typeof chrome !== "undefined" && chrome.storage?.onChanged) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes.redflow_config) return;
    const next = changes.redflow_config.newValue as
      | Partial<ExtensionConfig>
      | undefined;
    if (next) applyPaceConfig(next);
  });
}

export function pace(kind: PaceKind): number {
  return currentPace[kind] ?? DEFAULT_PACE_MS[kind];
}

export async function waitPace(kind: PaceKind): Promise<void> {
  await ensurePaceLoaded();
  await sleep(pace(kind));
}

function stepScale(): number {
  return pace("step") / DEFAULT_PACE_MS.step;
}

/** 标题/正文越长，等 React / TipTap 消化的时间越长；随「填表步骤」等比缩放 */
export function paceForText(text: string, floor = 480): number {
  const n = Array.from(text || "").length;
  const base = Math.min(2800, Math.max(floor, 280 + n * 14));
  return Math.max(50, Math.round(base * stepScale()));
}

/** 图片越多越大，从落地页跳到编辑页越慢；随「填表步骤」等比缩放 */
export function paceForImages(count: number, totalBytes: number): number {
  const n = Math.max(1, count);
  const sizeMs = Math.min(5000, Math.round(totalBytes / 2500));
  const base = 1400 + (n - 1) * 900 + sizeMs;
  return Math.max(80, Math.round(base * stepScale()));
}
