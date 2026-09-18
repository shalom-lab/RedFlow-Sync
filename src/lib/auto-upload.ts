/**
 * 单条草稿 → 小红书「暂存离开」完整流水线，以及顺序自动化队列。
 */
import { composePublishBody, listPublishTopics } from "./compose";
import { planAllowedPublishAt } from "./schedule";
import {
  clickFooterOnTab,
  fillPublishOnActiveTab,
  settleAfterZancun,
} from "./page-bridge";
import { sendRedFlow } from "./messages";
import type { FillPublishPageResponse } from "@/contents/publish-bridge";
import { waitPace } from "./pace";
import { getConfig } from "./storage";

export type DraftUploadInput = {
  category: string;
  fileId: string;
  title: string;
  keywords: string[];
  replyKeyword?: string;
  imageRawUrl?: string;
};

export type DraftUploadResult = FillPublishPageResponse & {
  marked?: boolean;
};

/** 自动化一次只跑 5 的倍数：满 5 成批，不满 5 不开跑 */
export const AUTO_BATCH_SIZE = 5;

export function takeBatchMultiple<T>(
  items: T[],
  size = AUTO_BATCH_SIZE,
): T[] {
  const n = Math.floor(items.length / size) * size;
  return items.slice(0, n);
}

/** 每天自动：有满 5 篇才跑，且只跑 5 篇 */
export function takeDailyBatch<T>(
  items: T[],
  size = AUTO_BATCH_SIZE,
): T[] {
  return items.length >= size ? items.slice(0, size) : [];
}

/**
 * 封装：读 id → 拉图 → 拼正文/话题 → 填表/合集 → 按设置暂存或定时发布 → 标记已处理
 * 不整页刷新：灌图跳转靠拆步消息 + PING 等编辑页。
 */
export async function runDraftToXiaohongshuDraft(
  item: DraftUploadInput,
): Promise<DraftUploadResult> {
  const cfg = await getConfig();
  const submitMode = cfg.submitMode === "schedule" ? "schedule" : "draft";

  const imgs = await sendRedFlow({
    type: "GET_IMAGES",
    category: item.category,
    fileId: item.fileId,
  });
  if (!imgs.ok) {
    return {
      ok: false,
      error: imgs.error || `未找到配图 infoflow-data/Prompt/${item.fileId}.json`,
    };
  }

  const body = composePublishBody({
    keywords: item.keywords,
    replyKeyword: item.replyKeyword,
  });
  const topics = listPublishTopics(item.keywords);
  const scheduledAt =
    submitMode === "schedule"
      ? planAllowedPublishAt(new Date(), {
          startHour: cfg.scheduleStartHour,
          endHour: cfg.scheduleEndHour,
          minLeadHours: cfg.scheduleMinLeadHours,
          maxAheadDays: cfg.scheduleMaxAheadDays,
        }).toISOString()
      : undefined;

  const result = await fillPublishOnActiveTab({
    category: item.category,
    fileId: item.fileId,
    title: item.title,
    body,
    topics,
    imageRawUrl: item.imageRawUrl,
    collectionName: "ChatGPT美图",
    scheduledAt,
    declareAiContent: cfg.declareAiContent,
  });

  if (!result.ok) return result;

  if (submitMode === "schedule" && !result.steps?.scheduled) {
    return {
      ...result,
      ok: false,
      error:
        result.error ||
        "已勾选定时发布，但页面定时未填上，未点红色按钮（避免点成立即「发布」）",
    };
  }

  const tabId = result.tabId;
  let draftSaved = false;
  if (result.draftPending && tabId != null) {
    draftSaved = await clickFooterOnTab(tabId, submitMode);
    if (draftSaved) await settleAfterZancun(tabId);
  } else if (tabId != null) {
    await waitPace("settle");
  }

  if (!draftSaved) {
    return {
      ...result,
      ok: false,
      error:
        result.error ||
        (submitMode === "schedule"
          ? "未点到红色「定时发布」。请确认已勾选并填好定时，红按钮文案须是「定时发布」而不是「发布」。"
          : "未点到「暂存离开」，草稿未入库。存草稿模式不会点红色按钮。"),
      steps: {
        ...result.steps,
        title: result.steps?.title ?? false,
        body: result.steps?.body ?? false,
        image: result.steps?.image ?? false,
        draftSaved: false,
      },
    };
  }

  const mark = await sendRedFlow({
    type: "MARK_UPLOADED",
    category: item.category,
    fileId: item.fileId,
  });

  return {
    ...result,
    steps: {
      ...result.steps,
      title: result.steps?.title ?? false,
      body: result.steps?.body ?? false,
      image: result.steps?.image ?? false,
      draftSaved,
    },
    marked: mark.ok,
  };
}

/** 未入库小红书草稿的条目，按 id（时间戳前缀）从旧到新 */
export function pickOldestPending(
  items: Array<DraftUploadInput & { uploaded?: boolean }>,
): DraftUploadInput[] {
  return items
    .filter((it) => !it.uploaded)
    .slice()
    .sort((a, b) => a.fileId.localeCompare(b.fileId, undefined, { numeric: true }));
}

export type AutoUploadProgress = {
  current: number;
  total: number;
  batchNo: number;
  batchCount: number;
  batchIndex: number;
  batchSize: number;
  title: string;
  fileId: string;
  scheduledAt?: string;
};

export type AutoUploadHooks = {
  onItemStart?: (
    item: DraftUploadInput,
    index: number,
    total: number,
    progress: AutoUploadProgress,
  ) => void;
  onItemDone?: (
    item: DraftUploadInput,
    result: DraftUploadResult,
    index: number,
    progress: AutoUploadProgress,
  ) => void;
  onStop?: (reason: "done" | "paused" | "error", detail?: string) => void;
};

/** 顺序自动化：开始 / 暂停（暂停=当前 5 篇这一批跑完再停） */
export class AutoUploadQueue {
  private running = false;
  private stopAfterBatch = false;

  get isRunning(): boolean {
    return this.running;
  }

  /** 请求暂停：当前 5 篇批次跑完后再停 */
  pause(): void {
    if (this.running) this.stopAfterBatch = true;
  }

  async start(
    items: DraftUploadInput[],
    hooks?: AutoUploadHooks,
  ): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.stopAfterBatch = false;

    const pending = pickOldestPending(items);
    const queue = takeBatchMultiple(pending, AUTO_BATCH_SIZE);

    if (!queue.length) {
      this.running = false;
      const leftover = pending.length;
      hooks?.onStop?.(
        "error",
        leftover
          ? `未满 ${AUTO_BATCH_SIZE} 篇（当前待处理 ${leftover} 条），一次只跑 ${AUTO_BATCH_SIZE} 的倍数`
          : "没有待处理草稿",
      );
      return;
    }

    const batchCount = queue.length / AUTO_BATCH_SIZE;

    try {
      for (let i = 0; i < queue.length; i++) {
        const item = queue[i]!;
        const batchNo = Math.floor(i / AUTO_BATCH_SIZE) + 1;
        const batchIndex = (i % AUTO_BATCH_SIZE) + 1;
        const progress: AutoUploadProgress = {
          current: i + 1,
          total: queue.length,
          batchNo,
          batchCount,
          batchIndex,
          batchSize: AUTO_BATCH_SIZE,
          title: item.title,
          fileId: item.fileId,
        };
        hooks?.onItemStart?.(item, i, queue.length, progress);
        let result: DraftUploadResult;
        try {
          result = await runDraftToXiaohongshuDraft(item);
        } catch (e) {
          result = {
            ok: false,
            error: e instanceof Error ? e.message : String(e),
          };
        }
        const doneProgress = {
          ...progress,
          scheduledAt: result.steps?.scheduledAt,
        };
        hooks?.onItemDone?.(item, result, i, doneProgress);

        const batchDone = batchIndex === AUTO_BATCH_SIZE;
        if (this.stopAfterBatch && batchDone) {
          hooks?.onStop?.(
            "paused",
            `已暂停（本批 ${AUTO_BATCH_SIZE} 篇已跑完，累计 ${i + 1} 篇）`,
          );
          return;
        }

        if (!result.ok) {
          await waitPace("settle");
          continue;
        }

        await waitPace("betweenDrafts");
      }
      hooks?.onStop?.(
        "done",
        `自动化完成 ${queue.length} 篇（${batchCount} 批 × ${AUTO_BATCH_SIZE}）`,
      );
    } finally {
      this.running = false;
      this.stopAfterBatch = false;
    }
  }
}

export const autoUploadQueue = new AutoUploadQueue();
