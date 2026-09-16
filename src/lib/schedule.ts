/** 小红书定时发布：按设置里的时段 / 提前天数随机（不必是今天） */

export type SchedulePlanOptions = {
  startHour: number;
  endHour: number;
  minLeadHours: number;
  maxAheadDays: number;
};

export const DEFAULT_SCHEDULE_PLAN: SchedulePlanOptions = {
  startHour: 10,
  endHour: 20,
  minLeadHours: 2,
  maxAheadDays: 14,
};

function clampInt(n: unknown, min: number, max: number, fallback: number): number {
  const v = typeof n === "number" ? n : Number(n);
  if (!Number.isFinite(v)) return fallback;
  return Math.min(max, Math.max(min, Math.round(v)));
}

export function normalizeSchedulePlan(
  raw?: Partial<SchedulePlanOptions> | null,
): SchedulePlanOptions {
  const startHour = clampInt(raw?.startHour, 0, 23, DEFAULT_SCHEDULE_PLAN.startHour);
  let endHour = clampInt(raw?.endHour, 0, 23, DEFAULT_SCHEDULE_PLAN.endHour);
  if (endHour < startHour) endHour = startHour;
  return {
    startHour,
    endHour,
    minLeadHours: clampInt(
      raw?.minLeadHours,
      1,
      48,
      DEFAULT_SCHEDULE_PLAN.minLeadHours,
    ),
    maxAheadDays: clampInt(
      raw?.maxAheadDays,
      1,
      14,
      DEFAULT_SCHEDULE_PLAN.maxAheadDays,
    ),
  };
}

/** 网页端日历通常最多约未来 14 天（以页面可点日期为准） */
export const XHS_SCHEDULE_MAX_AHEAD_DAYS = DEFAULT_SCHEDULE_PLAN.maxAheadDays;

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

function randomDaytimeOn(day: Date, plan: SchedulePlanOptions): Date {
  const span = plan.endHour - plan.startHour + 1;
  const hour = plan.startHour + Math.floor(Math.random() * Math.max(1, span));
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
 * 在「现在 + 最早间隔」到「最多提前天数内、结束小时:59 前」随机一个可发时刻。
 * 不按篇递增日期，所以经常不是今天。
 */
export function planAllowedPublishAt(
  now = new Date(),
  rawPlan?: Partial<SchedulePlanOptions> | null,
): Date {
  const plan = normalizeSchedulePlan(rawPlan);
  const minTime = new Date(now.getTime() + plan.minLeadHours * 60 * 60 * 1000);
  const maxTime = new Date(now);
  maxTime.setDate(maxTime.getDate() + plan.maxAheadDays);
  maxTime.setHours(plan.endHour, 59, 0, 0);

  const first = startOfDay(minTime);
  const last = startOfDay(maxTime);
  const days: Date[] = [];
  for (const cursor = new Date(first); cursor <= last; cursor.setDate(cursor.getDate() + 1)) {
    days.push(new Date(cursor));
  }

  for (let i = 0; i < 48; i++) {
    const day = days[Math.floor(Math.random() * days.length)] ?? first;
    const slot = randomDaytimeOn(day, plan);
    if (slot >= minTime && slot <= maxTime) return slot;
  }

  const fallback = randomDaytimeOn(first, plan);
  if (fallback < minTime) {
    const bump = new Date(minTime);
    if (bump.getHours() < plan.startHour) {
      bump.setHours(plan.startHour, Math.floor(Math.random() * 60), 0, 0);
    } else if (bump.getHours() > plan.endHour) {
      const next = new Date(first);
      next.setDate(next.getDate() + 1);
      return randomDaytimeOn(next, plan);
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
