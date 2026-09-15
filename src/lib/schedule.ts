/** 小红书定时发布：白天 10–20 点，日期在平台允许范围内随机（不必是今天） */

const DAY_START_HOUR = 10;
const DAY_END_HOUR = 20;
/** 创作者后台一般要求至少约 2 小时后 */
const MIN_LEAD_MS = 2 * 60 * 60 * 1000;
/** 网页端日历通常最多约未来 14 天（以页面可点日期为准） */
export const XHS_SCHEDULE_MAX_AHEAD_DAYS = 14;

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

export function formatXhsSchedule(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

export function parseXhsSchedule(text: string): Date | null {
  const m = text
    .trim()
    .match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
  if (!m) return null;
  const d = new Date(
    Number(m[1]),
    Number(m[2]) - 1,
    Number(m[3]),
    Number(m[4]),
    Number(m[5]),
    0,
    0,
  );
  return Number.isNaN(d.getTime()) ? null : d;
}

function randomDaytimeOn(day: Date): Date {
  const hour =
    DAY_START_HOUR +
    Math.floor(Math.random() * (DAY_END_HOUR - DAY_START_HOUR + 1));
  const minute = Math.floor(Math.random() * 60);
  const out = new Date(day);
  out.setHours(hour, minute, 0, 0);
  return out;
}

function startOfDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

/**
 * 在「现在 + 2 小时」到「今天起 14 天内、20:59 前」随机一个白天时刻。
 * 不按篇递增日期，所以经常不是今天。
 */
export function planAllowedPublishAt(now = new Date()): Date {
  const minTime = new Date(now.getTime() + MIN_LEAD_MS);
  const maxTime = new Date(now);
  maxTime.setDate(maxTime.getDate() + XHS_SCHEDULE_MAX_AHEAD_DAYS);
  maxTime.setHours(DAY_END_HOUR, 59, 0, 0);

  const first = startOfDay(minTime);
  const last = startOfDay(maxTime);
  const days: Date[] = [];
  for (const cursor = new Date(first); cursor <= last; cursor.setDate(cursor.getDate() + 1)) {
    days.push(new Date(cursor));
  }

  for (let i = 0; i < 48; i++) {
    const day = days[Math.floor(Math.random() * days.length)] ?? first;
    const slot = randomDaytimeOn(day);
    if (slot >= minTime && slot <= maxTime) return slot;
  }

  const fallback = randomDaytimeOn(first);
  if (fallback < minTime) {
    const bump = new Date(minTime);
    if (bump.getHours() < DAY_START_HOUR) {
      bump.setHours(DAY_START_HOUR, Math.floor(Math.random() * 60), 0, 0);
    } else if (bump.getHours() > DAY_END_HOUR) {
      const next = new Date(first);
      next.setDate(next.getDate() + 1);
      return randomDaytimeOn(next);
    } else {
      bump.setMinutes(Math.floor(Math.random() * 60), 0, 0);
    }
    return bump;
  }
  return fallback;
}

/** @deprecated 改用 planAllowedPublishAt；index 不再用来「第 n 篇排第 n 天」 */
export function planDaytimePublishAt(_index = 0, now = new Date()): Date {
  return planAllowedPublishAt(now);
}
