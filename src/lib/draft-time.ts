/** 草稿 fileId 时间戳约定与「导入起点」比较 */

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

/** 空门槛视为全部可导入；否则要求 fileId 严格晚于门槛 */
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
  return m ? m[1] : "";
}

/**
 * 手动选日期：存为当日末尾前缀，表示「该日及以前不可导」。
 * 与 fileId 前缀 `YYYY-MM-DDTHH-MM-SS-…` 可直接 localeCompare。
 */
export function dateInputToImportAfter(yyyyMmDd: string): string {
  const d = yyyyMmDd.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return "";
  return `${d}T23-59-59-999Z`;
}

/** 已导入项中最大 fileId，用作懒初始化门槛 */
export function maxUploadedFileId(
  items: Array<{ fileId: string; uploaded?: boolean }>,
): string {
  let max = "";
  for (const it of items) {
    if (!it.uploaded) continue;
    if (!max || compareFileIdTime(it.fileId, max) > 0) max = it.fileId;
  }
  return max;
}
