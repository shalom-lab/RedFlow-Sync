/** 按操作难度停顿，避免小红书 DOM 还没稳住就点下一步 */

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export type PaceKind =
  | "click"
  | "tab"
  | "nav"
  | "step"
  | "menu"
  | "calendar"
  | "settle"
  | "betweenDrafts";

const PACE_MS: Record<PaceKind, number> = {
  click: 420,
  tab: 1100,
  nav: 1500,
  step: 750,
  menu: 950,
  calendar: 700,
  settle: 3400,
  betweenDrafts: 2600,
};

export function pace(kind: PaceKind): number {
  return PACE_MS[kind];
}

export async function waitPace(kind: PaceKind): Promise<void> {
  await sleep(pace(kind));
}

/** 标题/正文越长，等 React / TipTap 消化的时间越长 */
export function paceForText(text: string, floor = 480): number {
  const n = Array.from(text || "").length;
  return Math.min(2800, Math.max(floor, 280 + n * 14));
}

/** 图片越多越大，从落地页跳到编辑页越慢 */
export function paceForImages(count: number, totalBytes: number): number {
  const n = Math.max(1, count);
  const sizeMs = Math.min(5000, Math.round(totalBytes / 2500));
  return 1400 + (n - 1) * 900 + sizeMs;
}
