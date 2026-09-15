/** 发布正文 / 话题拼接 */

/** 每条笔记必须出现的三个话题 */
export const REQUIRED_TOPICS = ["图美AI", "ChatGPT", "美图提示词"] as const;

export function normalizeTopic(raw: string): string {
  return raw.replace(/^#+/, "").trim();
}

/** 必选话题 + JSON keywords，去重保序 */
export function listPublishTopics(keywords: string[] = []): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of [...REQUIRED_TOPICS, ...keywords]) {
    const name = normalizeTopic(String(raw ?? ""));
    if (!name) continue;
    const key = name.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

/**
 * 拼接发布正文：
 * 🌈关键词 · 关键词
 * ✅回复关键词：xxx
 * #话题
 */
export function composePublishBody(opts: {
  keywords?: string[];
  replyKeyword?: string;
}): string {
  const keywords = (opts.keywords ?? [])
    .map((k) => normalizeTopic(String(k ?? "")))
    .filter(Boolean);
  const topics = listPublishTopics(keywords);
  const lines: string[] = [
    keywords.length ? `🌈${keywords.join(" · ")}` : "🌈",
  ];
  if (opts.replyKeyword?.trim()) {
    lines.push(`✅回复关键词：${opts.replyKeyword.trim()}`);
  }
  lines.push(topics.map((t) => `#${t}`).join(" "));
  return lines.join("\n");
}
