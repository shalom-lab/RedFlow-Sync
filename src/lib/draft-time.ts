/** 草稿 fileId 时间戳约定与「时间筛选窗口」比较 */

const FILE_ID_TIME_RE =
  /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})(?:-(\d+))?Z?/i;

/** 草稿 id 时间戳小字展示：2026-01-02T11-23-14-833Z-xxx → 2026-01-02 11:23 */
export function formatDraftTime(fileId: string): string {
  const m = fileId.match(FILE_ID_TIME_RE);
  if (m) return `${m[1]} ${m[2]}:${m[3]}`;
  return fileId.length > 22 ? `${fileId.slice(0, 20)}…` : fileId;
}

export function compareFileIdTime(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true });
}

/** fileId → YYYY-MM-DD；无法解析则空 */
export function fileIdDay(fileId: string): string {
  const m = fileId.trim().match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1]! : "";
}

/** 从草稿 id 收集去重日期，升序 */
export function collectDraftDays(fileIds: string[]): string[] {
  const set = new Set<string>();
  for (const id of fileIds) {
    const d = fileIdDay(id);
    if (d) set.add(d);
  }
  return [...set].sort();
}

/** 时间筛选窗口（按日）；空字符串表示该侧不限制 */
export type ImportWindow = {
  from: string;
  to: string;
};

export function emptyImportWindow(): ImportWindow {
  return { from: "", to: "" };
}

export function normalizeImportWindow(
  raw?: Partial<ImportWindow> | null,
): ImportWindow {
  const from =
    typeof raw?.from === "string" && /^\d{4}-\d{2}-\d{2}$/.test(raw.from.trim())
      ? raw.from.trim()
      : "";
  const to =
    typeof raw?.to === "string" && /^\d{4}-\d{2}-\d{2}$/.test(raw.to.trim())
      ? raw.to.trim()
      : "";
  if (from && to && from > to) return { from: to, to: from };
  return { from, to };
}

/** 是否在可导入时间窗口内（与已传标记无关） */
export function isInImportWindow(
  fileId: string,
  win: ImportWindow | null | undefined,
): boolean {
  const from = (win?.from ?? "").trim();
  const to = (win?.to ?? "").trim();
  if (from && compareFileIdTime(fileId, `${from}T00-00-00-000Z`) < 0) {
    return false;
  }
  if (to && compareFileIdTime(fileId, `${to}T23-59-59-999Z`) > 0) {
    return false;
  }
  return true;
}

/** @deprecated 兼容旧单门槛；请用 isInImportWindow */
export function isAfterImportAfter(
  fileId: string,
  importAfter: string | null | undefined,
): boolean {
  const cut = (importAfter ?? "").trim();
  if (!cut) return true;
  return compareFileIdTime(fileId, cut) > 0;
}

/** sync 门槛 → date input 的 YYYY-MM-DD */
export function importAfterToDateInput(importAfter: string): string {
  const m = importAfter.trim().match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1]! : "";
}

/**
 * 手动选日期：存为当日末尾前缀，表示「该日及以前不可导」。
 * @deprecated 时间筛选已改为窗口；保留给迁移用
 */
export function dateInputToImportAfter(yyyyMmDd: string): string {
  const d = yyyyMmDd.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return "";
  return `${d}T23-59-59-999Z`;
}

/** 展示用：08-03 或完整月日 */
export function formatDayShort(yyyyMmDd: string): string {
  const m = yyyyMmDd.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return yyyyMmDd;
  return `${m[2]}-${m[3]}`;
}

/**
 * 解析手动输入的年月日。
 * 支持 `2026-08-03` / `2026/08/03` / `2026.8.3`；空串表示不限制。
 * 非法返回 null。
 */
export function parseDayInput(raw: string): string | null {
  const s = raw.trim().replace(/[/.]/g, "-");
  if (!s) return "";
  const m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (!m) return null;
  const y = m[1]!;
  const mo = m[2]!.padStart(2, "0");
  const d = m[3]!.padStart(2, "0");
  const day = `${y}-${mo}-${d}`;
  const dt = new Date(`${day}T12:00:00.000Z`);
  if (Number.isNaN(dt.getTime()) || dt.toISOString().slice(0, 10) !== day) {
    return null;
  }
  return day;
}
