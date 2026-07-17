/** 分类 + fileId 复合键（上传历史 / IDB 共用） */
export function itemKey(category: string, fileId: string): string {
  return `${category}::${fileId}`;
}
