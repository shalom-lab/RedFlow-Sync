import { createThumbnailBlob } from "./thumb";
import { fileIdFromMediaKey, imageItemKey, itemKey } from "./keys";

const DB_NAME = "redflow-sync";
const DB_VERSION = 2;

export interface CachedItemRecord {
  /** `${category}::${fileId}` */
  key: string;
  fileId: string;
  category: string;
  title: string;
  body: string;
  keywords?: string[];
  replyKeyword?: string;
  imagePath: string;
  imageRawUrl: string;
  jsonPath: string;
  jsonSha: string;
  imageSha: string | null;
  updatedAt: string;
  /** 是否已成功导入到发布页 */
  uploaded: boolean;
  /** 导入成功时间；未导入为 null */
  uploadedAt: string | null;
}

export interface CachedImageRecord {
  key: string;
  fileId: string;
  category: string;
  blob: Blob;
  mime: string;
  sha: string | null;
  updatedAt: string;
}

export interface SyncMetaRecord {
  key: "global";
  lastSyncAt: string | null;
  lastError: string | null;
  lastResultSummary: string | null;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onerror = () => {
      dbPromise = null;
      reject(req.error ?? new Error("IndexedDB open failed"));
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onclose = () => {
        dbPromise = null;
      };
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      resolve(db);
    };
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("items")) {
        const items = db.createObjectStore("items", { keyPath: "key" });
        items.createIndex("byCategory", "category", { unique: false });
        items.createIndex("byFileId", "fileId", { unique: false });
      }
      if (!db.objectStoreNames.contains("images")) {
        db.createObjectStore("images", { keyPath: "key" });
      }
      if (!db.objectStoreNames.contains("thumbs")) {
        db.createObjectStore("thumbs", { keyPath: "key" });
      }
      if (!db.objectStoreNames.contains("meta")) {
        db.createObjectStore("meta", { keyPath: "key" });
      }
    };
  });

  return dbPromise;
}

function reqToPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IDB request failed"));
  });
}

export { itemKey, imageItemKey, fileIdFromMediaKey } from "./keys";

export async function idbPutItem(record: CachedItemRecord): Promise<void> {
  const db = await openDb();
  const tx = db.transaction("items", "readwrite");
  await reqToPromise(tx.objectStore("items").put(record));
}

export async function idbMarkUploaded(
  category: string,
  fileId: string,
): Promise<CachedItemRecord | null> {
  const prev = await idbGetItem(category, fileId);
  if (!prev) return null;
  const next: CachedItemRecord = {
    ...prev,
    uploaded: true,
    uploadedAt: new Date().toISOString(),
  };
  await idbPutItem(next);
  return next;
}

export async function idbClearUploadedFlags(): Promise<number> {
  const db = await openDb();
  const tx = db.transaction("items", "readonly");
  const rows = (await reqToPromise(
    tx.objectStore("items").getAll(),
  )) as CachedItemRecord[];
  let n = 0;
  for (const row of rows) {
    if (row.uploaded || row.uploadedAt) {
      await idbPutItem({
        ...row,
        uploaded: false,
        uploadedAt: null,
      });
      n += 1;
    }
  }
  return n;
}

export async function idbGetItem(
  category: string,
  fileId: string,
): Promise<CachedItemRecord | undefined> {
  const db = await openDb();
  const tx = db.transaction("items", "readonly");
  return await reqToPromise(
    tx.objectStore("items").get(itemKey(category, fileId)),
  );
}

export async function idbListByCategory(
  category: string,
): Promise<CachedItemRecord[]> {
  const db = await openDb();
  const tx = db.transaction("items", "readonly");
  const idx = tx.objectStore("items").index("byCategory");
  return await reqToPromise(idx.getAll(category));
}

export async function idbDeleteItem(key: string): Promise<void> {
  const db = await openDb();
  const stores = ["items", "images", "thumbs"].filter((n) =>
    db.objectStoreNames.contains(n),
  );
  const tx = db.transaction(stores, "readwrite");
  for (const name of stores) {
    tx.objectStore(name).delete(key);
  }
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function idbPutImage(record: CachedImageRecord): Promise<void> {
  const db = await openDb();
  const tx = db.transaction("images", "readwrite");
  await reqToPromise(tx.objectStore("images").put(record));
}

export async function idbPutThumb(record: CachedImageRecord): Promise<void> {
  const db = await openDb();
  const tx = db.transaction("thumbs", "readwrite");
  await reqToPromise(tx.objectStore("thumbs").put(record));
}

export async function idbGetImage(
  category: string,
  fileId: string,
): Promise<CachedImageRecord | undefined> {
  const db = await openDb();
  const tx = db.transaction("images", "readonly");
  const store = tx.objectStore("images");
  const multi = await reqToPromise(
    store.get(imageItemKey(category, fileId, 0)),
  );
  if (multi) return multi;
  return await reqToPromise(store.get(itemKey(category, fileId)));
}

export async function idbGetThumb(
  category: string,
  fileId: string,
): Promise<CachedImageRecord | undefined> {
  const db = await openDb();
  if (!db.objectStoreNames.contains("thumbs")) return undefined;
  const tx = db.transaction("thumbs", "readonly");
  const store = tx.objectStore("thumbs");
  const multi = await reqToPromise(
    store.get(imageItemKey(category, fileId, 0)),
  );
  if (multi) return multi;
  return await reqToPromise(store.get(itemKey(category, fileId)));
}

/** 列出某草稿的全部本地图片（按 index 排序） */
export async function idbListImages(
  category: string,
  fileId: string,
): Promise<CachedImageRecord[]> {
  const db = await openDb();
  const tx = db.transaction("images", "readonly");
  const allKeys = await reqToPromise(tx.objectStore("images").getAllKeys());
  const prefix = `${itemKey(category, fileId)}::`;
  const legacy = itemKey(category, fileId);
  const keys = allKeys
    .map(String)
    .filter((k) => k === legacy || k.startsWith(prefix))
    .sort((a, b) => {
      if (a === legacy) return -1;
      if (b === legacy) return 1;
      const ia = Number(a.slice(prefix.length)) || 0;
      const ib = Number(b.slice(prefix.length)) || 0;
      return ia - ib;
    });

  const out: CachedImageRecord[] = [];
  for (const k of keys) {
    const row = await reqToPromise(tx.objectStore("images").get(k));
    if (row) out.push(row as CachedImageRecord);
  }
  return out;
}

/** 仅清除某草稿在 images/thumbs 中的缓存（不动 items 元数据） */
export async function idbClearMediaForDraft(
  category: string,
  fileId: string,
): Promise<void> {
  const existing = await idbListImages(category, fileId);
  const db = await openDb();
  const stores = ["images", "thumbs"].filter((n) =>
    db.objectStoreNames.contains(n),
  );
  if (!stores.length) return;
  const tx = db.transaction(stores, "readwrite");
  const legacy = itemKey(category, fileId);
  for (const name of stores) {
    const store = tx.objectStore(name);
    store.delete(legacy);
    for (const row of existing) store.delete(row.key);
  }
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/** 用一组新图覆盖某草稿本地图片 */
export async function idbReplaceImages(
  category: string,
  fileId: string,
  images: Array<{ blob: Blob; mime: string; sha: string | null }>,
): Promise<void> {
  await idbClearMediaForDraft(category, fileId);

  const now = new Date().toISOString();
  for (let i = 0; i < images.length; i++) {
    const img = images[i]!;
    const key = imageItemKey(category, fileId, i);
    await idbPutImage({
      key,
      fileId,
      category,
      blob: img.blob,
      mime: img.mime,
      sha: img.sha,
      updatedAt: now,
    });
    if (i === 0) {
      try {
        const thumb = await createThumbnailBlob(img.blob);
        await idbPutThumb({
          key,
          fileId,
          category,
          blob: thumb,
          mime: "image/jpeg",
          sha: img.sha,
          updatedAt: now,
        });
      } catch {
        /* SW / OffscreenCanvas 不可用时跳过缩略图 */
      }
    }
  }
}

/** 轻量：只查 key 是否存在，不读 Blob */
export async function idbHasKey(
  store: "images" | "thumbs",
  category: string,
  fileId: string,
): Promise<boolean> {
  const db = await openDb();
  if (!db.objectStoreNames.contains(store)) return false;
  const tx = db.transaction(store, "readonly");
  const multi = await reqToPromise(
    tx.objectStore(store).getKey(imageItemKey(category, fileId, 0)),
  );
  if (multi != null) return true;
  const key = await reqToPromise(
    tx.objectStore(store).getKey(itemKey(category, fileId)),
  );
  return key != null;
}

export async function idbHasImage(
  category: string,
  fileId: string,
): Promise<boolean> {
  return idbHasKey("images", category, fileId);
}

export async function idbHasThumb(
  category: string,
  fileId: string,
): Promise<boolean> {
  return idbHasKey("thumbs", category, fileId);
}

/** 一次事务批量查某分类下 images/thumbs 是否存在 */
export async function idbMediaFlagsByCategory(category: string): Promise<{
  imageKeys: Set<string>;
  thumbKeys: Set<string>;
}> {
  const db = await openDb();
  const storeNames = ["images", "thumbs"].filter((n) =>
    db.objectStoreNames.contains(n),
  );
  const tx = db.transaction(storeNames, "readonly");

  const collectKeys = async (storeName: string): Promise<Set<string>> => {
    const store = tx.objectStore(storeName);
    const allKeys = await reqToPromise(store.getAllKeys());
    const set = new Set<string>();
    for (const k of allKeys) {
      const fileId = fileIdFromMediaKey(String(k), category);
      if (fileId) set.add(fileId);
    }
    return set;
  };

  const imageKeys = storeNames.includes("images")
    ? await collectKeys("images")
    : new Set<string>();
  const thumbKeys = storeNames.includes("thumbs")
    ? await collectKeys("thumbs")
    : new Set<string>();

  return { imageKeys, thumbKeys };
}

export async function idbCountItems(): Promise<number> {
  const db = await openDb();
  const tx = db.transaction("items", "readonly");
  return await reqToPromise(tx.objectStore("items").count());
}

/** 清空某个分类下的条目（含图片/缩略图） */
export async function idbClearCategory(category: string): Promise<number> {
  const rows = await idbListByCategory(category);
  for (const row of rows) {
    await idbDeleteItem(row.key);
  }
  return rows.length;
}

/** 只清空条目索引，保留 images/thumbs（配图下载成本高，留给历史页） */
export async function idbClearItemsStore(): Promise<void> {
  const db = await openDb();
  const tx = db.transaction("items", "readwrite");
  tx.objectStore("items").clear();
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/** 只清空草稿索引 JSON 与同步元数据，配图和仓库配置都保留 */
export async function idbClearDraftIndex(): Promise<void> {
  const db = await openDb();
  const stores = ["items", "meta"].filter((n) =>
    db.objectStoreNames.contains(n),
  );
  const tx = db.transaction(stores, "readwrite");
  for (const name of stores) {
    tx.objectStore(name).clear();
  }
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function idbGetMeta(): Promise<SyncMetaRecord> {
  const db = await openDb();
  const tx = db.transaction("meta", "readonly");
  const row = await reqToPromise(tx.objectStore("meta").get("global"));
  return (
    row ?? {
      key: "global",
      lastSyncAt: null,
      lastError: null,
      lastResultSummary: null,
    }
  );
}

export async function idbSetMeta(
  patch: Partial<Omit<SyncMetaRecord, "key">>,
): Promise<void> {
  const prev = await idbGetMeta();
  const next: SyncMetaRecord = { ...prev, ...patch, key: "global" };
  const db = await openDb();
  const tx = db.transaction("meta", "readwrite");
  await reqToPromise(tx.objectStore("meta").put(next));
}
