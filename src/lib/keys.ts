/** 分类 + fileId 复合键（上传历史 / IDB 共用） */
export function itemKey(category: string, fileId: string): string {
  return `${category}::${fileId}`;
}

/** 多图：category::fileId::index */
export function imageItemKey(
  category: string,
  fileId: string,
  index: number,
): string {
  return `${itemKey(category, fileId)}::${index}`;
}

/** 从 images/thumbs 的 key 解析出 fileId（兼容旧单图 key） */
export function fileIdFromMediaKey(key: string, category: string): string | null {
  const prefix = `${category}::`;
  if (!key.startsWith(prefix)) return null;
  const rest = key.slice(prefix.length);
  const m = rest.match(/^(.*)::(\d+)$/);
  if (m) return m[1]!;
  return rest;
}
