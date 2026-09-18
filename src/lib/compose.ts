/** 发布正文 / 话题拼接 */

import { DEFAULT_REQUIRED_TOPICS } from "@/types";

/** 兼容旧代码：默认必选话题（会被配置覆盖） */
export const REQUIRED_TOPICS = ["图美AI", "ChatGPT", "AI作图提示词"] as const;

export function normalizeTopic(raw: string): string {
  return raw.replace(/^#+/, "").trim();
}

/** 解析配置里的必选话题字符串 */
export function parseRequiredTopics(raw?: string | null): string[] {
  const text = (raw ?? DEFAULT_REQUIRED_TOPICS).trim();
  if (!text) return [...REQUIRED_TOPICS];
  return text
    .split(/[,，、\s]+/)
    .map((s) => normalizeTopic(s))
    .filter(Boolean);
}

/** 必选话题 + JSON keywords，去重保序 */
export function listPublishTopics(
  keywords: string[] = [],
  requiredTopics?: string[] | string | null,
): string[] {
  const required = Array.isArray(requiredTopics)
    ? requiredTopics.map(normalizeTopic).filter(Boolean)
    : parseRequiredTopics(
        typeof requiredTopics === "string" ? requiredTopics : undefined,
      );
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of [...required, ...keywords]) {
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
 * 👉获取方式：详见置顶笔记
 * ✅回复口令：xxx
 * #话题
 */
export function composePublishBody(opts: {
  keywords?: string[];
  replyKeyword?: string;
  requiredTopics?: string[] | string | null;
}): string {
  const keywords = (opts.keywords ?? [])
    .map((k) => normalizeTopic(String(k ?? "")))
    .filter(Boolean);
  const topics = listPublishTopics(keywords, opts.requiredTopics);
  const lines: string[] = [
    keywords.length ? `🌈${keywords.join(" · ")}` : "🌈",
  ];
  lines.push("👉获取方式：详见置顶笔记");
  if (opts.replyKeyword?.trim()) {
    lines.push(`✅回复口令：${opts.replyKeyword.trim()}`);
  }
  lines.push(topics.map((t) => `#${t}`).join(" "));
  return lines.join("\n");
}
