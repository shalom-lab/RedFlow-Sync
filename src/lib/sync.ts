import { itemKey } from "./keys";
import type { CachedItemDTO, SyncRunResult } from "./messages";
import {
  assertGitHubReady,
  buildRawUrl,
  deriveTitle,
  fetchBlob,
  fetchJsonFile,
  getCategoryList,
  joinPath,
  listDirectory,
  resolveImagePath,
} from "./github";
import {
  idbCountItems,
  idbDeleteItem,
  idbGetImage,
  idbGetMeta,
  idbGetThumb,
  idbListByCategory,
  idbMediaFlagsByCategory,
  idbPutImage,
  idbPutItem,
  idbPutThumb,
  idbSetMeta,
  type CachedItemRecord,
} from "./idb";
import { createThumbnailBlob } from "./thumb";
import type { ExtensionConfig, InfoFlowJson } from "@/types";

let activeSync: Promise<SyncRunResult> | null = null;

export function isSyncing(): boolean {
  return activeSync != null;
}

/**
 * 增量同步；并发调用会共用同一次 Promise，避免「同步进行中」误报。
 */
export async function runIncrementalSync(
  config: ExtensionConfig,
): Promise<SyncRunResult> {
  if (activeSync) return activeSync;

  activeSync = (async () => {
    const started = Date.now();
    const result: SyncRunResult = {
      categories: 0,
      fetchedJson: 0,
      fetchedImages: 0,
      skipped: 0,
      removed: 0,
      durationMs: 0,
    };

    try {
      await assertGitHubReady(config);
      const categories = getCategoryList(config);
      if (!categories.length) {
        throw new Error("请先配置至少一个 category");
      }

      for (const category of categories) {
        result.categories += 1;
        const partial = await syncOneCategory(config, category);
        result.fetchedJson += partial.fetchedJson;
        result.fetchedImages += partial.fetchedImages;
        result.skipped += partial.skipped;
        result.removed += partial.removed;
      }

      result.durationMs = Date.now() - started;
      await idbSetMeta({
        lastSyncAt: new Date().toISOString(),
        lastError: null,
        lastResultSummary: `+json ${result.fetchedJson} / +img ${result.fetchedImages} / skip ${result.skipped} / rem ${result.removed}`,
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

async function syncOneCategory(
  config: ExtensionConfig,
  category: string,
): Promise<
  Pick<SyncRunResult, "fetchedJson" | "fetchedImages" | "skipped" | "removed">
> {
  const stats = {
    fetchedJson: 0,
    fetchedImages: 0,
    skipped: 0,
    removed: 0,
  };

  const jsonDir = joinPath(config.basePath, category);
  const imgDir = joinPath(config.basePath, "Images", category);

  const [jsonList, imgList] = await Promise.all([
    listDirectory(config, jsonDir),
    listDirectory(config, imgDir),
  ]);

  // JSON 目录 404：路径/权限问题，禁止当成空目录清理本地缓存
  if (jsonList.missing) {
    throw new Error(
      `分类目录不存在或无权访问：${jsonDir || "(repo root)/" + category}。请检查 basePath / category / Token。本地缓存未改动。`,
    );
  }

  const jsonEntries = jsonList.entries;
  const imgEntries = imgList.missing ? [] : imgList.entries;

  const imgByBase = new Map(
    imgEntries
      .filter((e) => e.type === "file")
      .map((e) => {
        const base = e.name.replace(/\.(png|jpe?g|webp)$/i, "");
        return [base, e] as const;
      }),
  );

  const remoteIds = new Set<string>();
  const jsonFiles = jsonEntries.filter(
    (e) => e.type === "file" && e.name.toLowerCase().endsWith(".json"),
  );

  const localRows = await idbListByCategory(category);
  const localById = new Map(localRows.map((r) => [r.fileId, r]));
  const mediaFlags = await idbMediaFlagsByCategory(category);

  for (const file of jsonFiles) {
    const fileId = file.name.replace(/\.json$/i, "");
    remoteIds.add(fileId);

    const local = localById.get(fileId);
    const imgMeta = imgByBase.get(fileId);
    const hasImg = mediaFlags.imageKeys.has(fileId);
    const hasThumb = mediaFlags.thumbKeys.has(fileId);
    const needJson = !local || local.jsonSha !== file.sha;

    let title = local?.title ?? `【AI灵感】${fileId}`;
    let body = local?.body ?? "";
    let imagePath = local?.imagePath ?? "";
    let imageRawUrl = local?.imageRawUrl ?? "";
    let jsonPath = file.path;
    let imagePathChanged = false;

    if (needJson) {
      try {
        const json = await fetchJsonFile<InfoFlowJson>(config, file.path);
        title = deriveTitle(json, fileId);
        body = (json.content ?? "").toString();
        const nextPath = resolveImagePath(config, category, fileId, json);
        const nextUrl = nextPath.startsWith("http")
          ? nextPath
          : buildRawUrl(config, nextPath);
        imagePathChanged =
          Boolean(local) &&
          (local!.imagePath !== nextPath || local!.imageRawUrl !== nextUrl);
        imagePath = nextPath;
        imageRawUrl = nextUrl;
        jsonPath = file.path;
        stats.fetchedJson += 1;
      } catch (err) {
        console.warn(`[RedFlow sync] JSON 跳过 ${file.path}`, err);
        continue;
      }
    }

    const needImg =
      !hasImg ||
      imagePathChanged ||
      Boolean(imgMeta && local?.imageSha !== imgMeta.sha);
    const needThumbOnly = hasImg && !hasThumb && !needImg;

    if (!needJson && !needImg && !needThumbOnly) {
      stats.skipped += 1;
      continue;
    }

    let imageSha: string | null = local?.imageSha ?? null;

    if (needImg) {
      try {
        const pathOrUrl =
          imageRawUrl ||
          (imgMeta ? imgMeta.path : joinPath(imgDir, `${fileId}.png`));
        const blob = await fetchBlob(config, pathOrUrl);
        const mime =
          blob.type && blob.type.startsWith("image/")
            ? blob.type
            : "image/png";
        imageSha = imgMeta?.sha ?? `url:${pathOrUrl}`;
        const key = itemKey(category, fileId);
        const now = new Date().toISOString();
        await idbPutImage({
          key,
          fileId,
          category,
          blob,
          mime,
          sha: imageSha,
          updatedAt: now,
        });
        try {
          const thumb = await createThumbnailBlob(blob);
          await idbPutThumb({
            key,
            fileId,
            category,
            blob: thumb,
            mime: "image/jpeg",
            sha: imageSha,
            updatedAt: now,
          });
        } catch (thumbErr) {
          console.warn(`[RedFlow sync] 缩略图生成失败 ${fileId}`, thumbErr);
        }
        stats.fetchedImages += 1;
      } catch (err) {
        console.warn(`[RedFlow sync] 图片跳过 ${fileId}`, err);
      }
    } else if (needThumbOnly) {
      try {
        const full = await idbGetImage(category, fileId);
        if (full?.blob) {
          const thumb = await createThumbnailBlob(full.blob);
          await idbPutThumb({
            key: itemKey(category, fileId),
            fileId,
            category,
            blob: thumb,
            mime: "image/jpeg",
            sha: full.sha,
            updatedAt: new Date().toISOString(),
          });
        }
      } catch (thumbErr) {
        console.warn(`[RedFlow sync] 缩略图补全失败 ${fileId}`, thumbErr);
      }
    }

    const record: CachedItemRecord = {
      key: itemKey(category, fileId),
      fileId,
      category,
      title,
      body,
      imagePath,
      imageRawUrl,
      jsonPath,
      jsonSha: file.sha,
      imageSha,
      updatedAt: new Date().toISOString(),
    };
    await idbPutItem(record);
  }

  // 孤儿清理：列表过大时 Contents API 可能不完整，保守跳过删除
  const locals = localRows;
  const remoteCount = remoteIds.size;
  const localCount = locals.length;
  const suspiciousGap =
    remoteCount > 0 &&
    localCount > remoteCount * 3 &&
    localCount - remoteCount > 30;

  if (suspiciousGap) {
    console.warn(
      `[RedFlow sync] 跳过孤儿清理：本地 ${localCount} vs 远程 ${remoteCount}，疑似列表不完整`,
    );
  } else {
    for (const row of locals) {
      if (!remoteIds.has(row.fileId)) {
        await idbDeleteItem(row.key);
        stats.removed += 1;
      }
    }
  }

  return stats;
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
  const [rows, flags] = await Promise.all([
    idbListByCategory(category),
    idbMediaFlagsByCategory(category),
  ]);
  return rows.map((row) => ({
    fileId: row.fileId,
    category: row.category,
    title: row.title,
    body: row.body,
    imagePath: row.imagePath,
    imageRawUrl: row.imageRawUrl,
    jsonPath: row.jsonPath,
    jsonSha: row.jsonSha,
    imageSha: row.imageSha,
    updatedAt: row.updatedAt,
    hasImage: flags.imageKeys.has(row.fileId),
    hasThumb: flags.thumbKeys.has(row.fileId),
  }));
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

  const img = await idbGetImage(category, fileId);
  if (!img?.blob) return null;
  return {
    buffer: await img.blob.arrayBuffer(),
    mime: img.mime || "image/png",
  };
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
