import { itemKey } from "./keys";
import { composePublishBody } from "./compose";
import type { CachedItemDTO, SyncRunResult } from "./messages";
import {
  assertGitHubReady,
  buildRawUrl,
  fetchBlob,
  fetchJsonFile,
  getFileMeta,
  joinPath,
  type GitHubContentItem,
} from "./github";
import {
  idbClearItemsStore,
  idbClearMediaForDraft,
  idbCountItems,
  idbGetMeta,
  idbGetImage,
  idbGetThumb,
  idbListByCategory,
  idbListImages,
  idbMediaFlagsByCategory,
  idbPutItem,
  idbPutThumb,
  idbReplaceImages,
  idbSetMeta,
  type CachedItemRecord,
} from "./idb";
import { createThumbnailBlob } from "./thumb";
import { getConfig } from "./storage";
import {
  DRAFTS_CATEGORY,
  DEFAULT_DRAFTS_FILE,
  DEFAULT_IMAGES_PATH,
  DEFAULT_PROMPTS_PATH,
  type ExtensionConfig,
  type WechatDraftItem,
} from "@/types";

let activeSync: Promise<SyncRunResult> | null = null;

/** 单条草稿最多灌入张数 */
const MAX_DRAFT_IMAGES = 10;
const IMAGE_EXTS = ["png", "jpg", "jpeg", "webp"] as const;

export function isSyncing(): boolean {
  return activeSync != null;
}

function draftsFilePath(config: ExtensionConfig): string {
  const raw = (config.basePath || DEFAULT_DRAFTS_FILE).trim().replace(/^\/+/, "");
  return raw || DEFAULT_DRAFTS_FILE;
}

/** 配图目录；配置若写成 …/Images 会自动补 Prompt */
function imagesRoot(config: ExtensionConfig): string {
  const raw = (config.imagesPath || DEFAULT_IMAGES_PATH)
    .trim()
    .replace(/^\/+|\/+$/g, "");
  const root = raw || DEFAULT_IMAGES_PATH;
  const last = root.split("/").pop()?.toLowerCase() ?? "";
  if (last === "prompt") return root;
  return joinPath(root, "Prompt");
}

/** 与配图同级：…/Images/Prompt → …/Prompt */
function promptsRoot(config: ExtensionConfig): string {
  const images = imagesRoot(config);
  const m = images.match(/^(.*)\/Images\/Prompt$/i);
  if (m) {
    const base = (m[1] || "").replace(/^\/+|\/+$/g, "");
    return base ? joinPath(base, "Prompt") : "Prompt";
  }
  return DEFAULT_PROMPTS_PATH;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((x) => (typeof x === "string" ? x.trim() : String(x ?? "").trim()))
    .filter(Boolean);
}

/** 兼容 `{ items: [] }` / `{ data: [] }` / 顶层数组 */
export function extractDraftItems(data: unknown): WechatDraftItem[] {
  let rows: unknown[] = [];
  if (Array.isArray(data)) {
    rows = data;
  } else if (data && typeof data === "object") {
    const obj = data as Record<string, unknown>;
    if (Array.isArray(obj.items)) rows = obj.items;
    else if (Array.isArray(obj.data)) rows = obj.data;
    else if (Array.isArray(obj.drafts)) rows = obj.drafts;
  }

  const out: WechatDraftItem[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    const id = typeof r.id === "string" ? r.id.trim() : "";
    if (!id) continue;
    const title =
      typeof r.wechat_title === "string"
        ? r.wechat_title.trim()
        : typeof r.title === "string"
          ? r.title.trim()
          : "";
    const keywords = asStringArray(r.keywords);
    const reply =
      typeof r.reply_keyword === "string"
        ? r.reply_keyword.trim()
        : typeof r.replyKeyword === "string"
          ? r.replyKeyword.trim()
          : "";
    out.push({
      id,
      wechat_title: title,
      keywords,
      reply_keyword: reply,
    });
  }
  return out;
}

function draftBody(item: WechatDraftItem, bodyTemplate?: string): string {
  return composePublishBody({
    keywords: item.keywords,
    replyKeyword: item.reply_keyword,
    bodyTemplate,
  });
}

/**
 * image 为首图；images 为后续图；合并去重（按图片文件名 id）。
 * 仅有其一则只用该字段。
 */
export function mergePromptImageFields(
  image: unknown,
  images: unknown,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (raw: unknown) => {
    if (typeof raw !== "string") return;
    const stem = extractImageStem(raw);
    if (!stem || seen.has(stem)) return;
    seen.add(stem);
    out.push(stem);
  };
  push(image);
  if (Array.isArray(images)) {
    for (const item of images) push(item);
  }
  return out;
}

/**
 * 从 JSON 里的相对路径取出图片 id（文件名去扩展名）
 * 例：../Images/Prompt/2026-09-14T08-29-25-380Z-jlpnai-2.png
 *   → 2026-09-14T08-29-25-380Z-jlpnai-2
 */
export function extractImageStem(pathOrUrl: string): string {
  const cleaned = pathOrUrl.trim().replace(/\\/g, "/");
  const base = cleaned.split("/").filter(Boolean).pop() || "";
  return base.replace(/\.(png|jpe?g|webp)$/i, "");
}

type PromptMetaJson = {
  image?: unknown;
  images?: unknown;
};

async function probeImageInPromptDir(
  config: ExtensionConfig,
  stem: string,
): Promise<GitHubContentItem | null> {
  const dir = imagesRoot(config);
  for (const ext of IMAGE_EXTS) {
    const path = joinPath(dir, `${stem}.${ext}`);
    try {
      const meta = await getFileMeta(config, path);
      if (meta) return meta;
    } catch (err) {
      console.warn(`[RedFlow] getFileMeta 失败 ${path}`, err);
    }
  }
  // Contents API 不可用时，仍按 Images/Prompt/{id}.png 构造路径，交给 raw 下载
  return {
    name: `${stem}.png`,
    path: joinPath(dir, `${stem}.png`),
    type: "file",
    download_url: null,
    sha: "",
  };
}

/**
 * 按 prompt id：
 * 1. 读 Prompt/{id}.json
 * 2. 合并 image（首图）+ images，取出图片文件名 id
 * 3. 到 Images/Prompt/{图片id}.png 下载（不跟 JSON 里的相对路径走）
 */
export async function resolveDraftImageEntries(
  config: ExtensionConfig,
  draftId: string,
): Promise<GitHubContentItem[]> {
  const key = draftId.trim();
  if (!key) return [];

  const jsonPath = joinPath(promptsRoot(config), `${key}.json`);
  let meta: PromptMetaJson;
  try {
    meta = await fetchJsonFile<PromptMetaJson>(config, jsonPath);
  } catch (err) {
    console.warn(`[RedFlow] 读取 Prompt JSON 失败 ${jsonPath}`, err);
    return [];
  }

  const stems = mergePromptImageFields(meta.image, meta.images).slice(
    0,
    MAX_DRAFT_IMAGES,
  );
  if (!stems.length) {
    console.warn(`[RedFlow] Prompt JSON 无 image/images：${jsonPath}`);
    return [];
  }

  console.info(
    `[RedFlow] ${key} 配图 id：`,
    stems,
    `→ ${imagesRoot(config)}/{id}.png`,
  );

  const entries: GitHubContentItem[] = [];
  for (const stem of stems) {
    const file = await probeImageInPromptDir(config, stem);
    if (file) entries.push(file);
  }
  return entries;
}

/** 导入时按草稿 id → Prompt/{id}.json → Images/Prompt/{图片id}.png */
export async function cacheDraftImages(
  config: ExtensionConfig,
  draftId: string,
): Promise<{ count: number; paths: string[] }> {
  const entries = await resolveDraftImageEntries(config, draftId);
  if (!entries.length) {
    return { count: 0, paths: [] };
  }

  const dir = imagesRoot(config);
  const images: Array<{ blob: Blob; mime: string; sha: string | null }> = [];
  const paths: string[] = [];

  for (const entry of entries.slice(0, MAX_DRAFT_IMAGES)) {
    const stem = extractImageStem(entry.name || entry.path);
    let downloaded = false;
    for (const ext of IMAGE_EXTS) {
      const path = joinPath(dir, `${stem}.${ext}`);
      try {
        const blob = await fetchBlob(config, path);
        const mime =
          blob.type && blob.type.startsWith("image/")
            ? blob.type
            : `image/${ext === "jpg" ? "jpeg" : ext}`;
        images.push({ blob, mime, sha: entry.sha || null });
        paths.push(path);
        downloaded = true;
        break;
      } catch (err) {
        console.warn(`[RedFlow sync] 尝试 ${path} 失败`, err);
      }
    }
    if (!downloaded) {
      console.warn(
        `[RedFlow sync] 配图下载失败 Images/Prompt/${stem}.png（及 jpg/webp）`,
      );
    }
  }

  if (images.length) {
    await idbReplaceImages(DRAFTS_CATEGORY, draftId, images);
  }
  return { count: images.length, paths };
}

/**
 * 同步草稿索引（仅 JSON，不同步图片）。
 * 配图在导入单条时按需下载，上传成功后删除本地缓存。
 */
export async function runIncrementalSync(
  config: ExtensionConfig,
): Promise<SyncRunResult> {
  if (activeSync) return activeSync;

  activeSync = (async () => {
    const started = Date.now();
    const result: SyncRunResult = {
      categories: 1,
      fetchedJson: 0,
      fetchedImages: 0,
      skipped: 0,
      removed: 0,
      durationMs: 0,
    };

    try {
      await assertGitHubReady(config);
      const path = draftsFilePath(config);
      const raw = await fetchJsonFile<unknown>(config, path);
      const drafts = extractDraftItems(raw);
      if (!drafts.length) {
        throw new Error(
          `草稿文件无有效条目：${path}。请确认文件存在且含 id / wechat_title 等字段。`,
        );
      }

      const prevRows = await idbListByCategory(DRAFTS_CATEGORY);
      const prevById = new Map(prevRows.map((r) => [r.fileId, r]));
      await idbClearItemsStore();

      const now = new Date().toISOString();
      const promptDir = promptsRoot(config);

      for (const draft of drafts) {
        const prev = prevById.get(draft.id);
        // 配图路径以 Prompt/{id}.json 的 image/images 为准，导入时再解析下载
        const imagePath = joinPath(promptDir, `${draft.id}.json`);
        const record: CachedItemRecord = {
          key: itemKey(DRAFTS_CATEGORY, draft.id),
          fileId: draft.id,
          category: DRAFTS_CATEGORY,
          title: draft.wechat_title || `【草稿】${draft.id}`,
          body: draftBody(draft, config.bodyTemplate),
          keywords: draft.keywords,
          replyKeyword: draft.reply_keyword,
          imagePath,
          imageRawUrl: buildRawUrl(config, imagePath),
          jsonPath: path,
          jsonSha: `drafts:${drafts.length}:${draft.id}`,
          imageSha: null,
          updatedAt: now,
          uploaded: prev?.uploaded ?? false,
          uploadedAt: prev?.uploadedAt ?? null,
        };
        await idbPutItem(record);
        result.fetchedJson += 1;
      }

      result.durationMs = Date.now() - started;
      await idbSetMeta({
        lastSyncAt: new Date().toISOString(),
        lastError: null,
        lastResultSummary: `drafts ${result.fetchedJson} from ${path} (images on import)`,
      });
      return result;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await idbSetMeta({ lastError: msg });
      throw e;
    } finally {
      result.durationMs = Date.now() - started;
    }
  })();

  try {
    return await activeSync;
  } finally {
    activeSync = null;
  }
}

export async function getSyncStatusDto() {
  const meta = await idbGetMeta();
  return {
    lastSyncAt: meta.lastSyncAt,
    lastError: meta.lastError,
    syncing: isSyncing(),
    itemCount: await idbCountItems(),
  };
}

export async function getLocalItemsDto(
  category: string,
): Promise<CachedItemDTO[]> {
  const cat = category.trim() || DRAFTS_CATEGORY;
  const [rows, flags] = await Promise.all([
    idbListByCategory(cat),
    idbMediaFlagsByCategory(cat),
  ]);
  return rows
    .map((row) => ({
      fileId: row.fileId,
      category: row.category,
      title: row.title,
      body: row.body,
      keywords: row.keywords ?? [],
      replyKeyword: row.replyKeyword ?? "",
      imagePath: row.imagePath,
      imageRawUrl: row.imageRawUrl,
      jsonPath: row.jsonPath,
      jsonSha: row.jsonSha,
      imageSha: row.imageSha,
      updatedAt: row.updatedAt,
      uploaded: Boolean(row.uploaded),
      uploadedAt: row.uploadedAt ?? null,
      hasImage: flags.imageKeys.has(row.fileId),
      hasThumb: flags.thumbKeys.has(row.fileId),
    }))
    .sort((a, b) => Number(a.uploaded) - Number(b.uploaded));
}

export async function getImagesArrayBuffers(
  category: string,
  fileId: string,
): Promise<Array<{ buffer: ArrayBuffer; mime: string }>> {
  // 侧栏可先预拉；CS 再请求时直接读 IDB，缩短 tabs 消息通道占用时间
  const existing = await idbListImages(category, fileId);
  if (existing.length) {
    return Promise.all(
      existing.map(async (row) => ({
        buffer: await row.blob.arrayBuffer(),
        mime: row.mime || "image/png",
      })),
    );
  }

  // 导入时再下：不同步全量图，按条从 GitHub 拉
  // 注意：Service Worker 里禁止 await import()——Vite preload 会访问 window
  try {
    const config = await getConfig();
    await assertGitHubReady(config);
    const cached = await cacheDraftImages(config, fileId);
    if (!cached.count) return [];
  } catch (err) {
    console.warn(`[RedFlow] import-time image fetch fail ${fileId}`, err);
    throw err;
  }

  const rows = await idbListImages(category, fileId);
  const out: Array<{ buffer: ArrayBuffer; mime: string }> = [];
  for (const row of rows) {
    out.push({
      buffer: await row.blob.arrayBuffer(),
      mime: row.mime || "image/png",
    });
  }
  return out;
}

/** 上传成功后删除该条临时配图 */
export async function clearDraftImages(
  category: string,
  fileId: string,
): Promise<void> {
  await idbClearMediaForDraft(category, fileId);
}

export async function getImageArrayBuffer(
  category: string,
  fileId: string,
  variant: "thumb" | "full" = "thumb",
): Promise<{ buffer: ArrayBuffer; mime: string } | null> {
  if (variant === "thumb") {
    const thumb = await idbGetThumb(category, fileId);
    if (thumb?.blob) {
      return {
        buffer: await thumb.blob.arrayBuffer(),
        mime: thumb.mime || "image/jpeg",
      };
    }
    const full = await idbGetImage(category, fileId);
    if (!full?.blob) return null;
    try {
      const blob = await createThumbnailBlob(full.blob);
      await idbPutThumb({
        key: itemKey(category, fileId),
        fileId,
        category,
        blob,
        mime: "image/jpeg",
        sha: full.sha,
        updatedAt: new Date().toISOString(),
      });
      return {
        buffer: await blob.arrayBuffer(),
        mime: "image/jpeg",
      };
    } catch {
      return {
        buffer: await full.blob.arrayBuffer(),
        mime: full.mime || "image/png",
      };
    }
  }

  const imgs = await getImagesArrayBuffers(category, fileId);
  return imgs[0] ?? null;
}

/** 若距上次同步超过 thresholdMs，则触发增量同步 */
export async function syncIfStale(
  config: ExtensionConfig,
  thresholdMs = 30 * 60 * 1000,
): Promise<boolean> {
  const meta = await idbGetMeta();
  if (meta.lastSyncAt) {
    const age = Date.now() - new Date(meta.lastSyncAt).getTime();
    if (age < thresholdMs) return false;
  }
  await runIncrementalSync(config);
  return true;
}

export { DRAFTS_CATEGORY };
