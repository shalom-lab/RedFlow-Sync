import { itemKey } from "./keys";

const DB_NAME = "redflow-sync";
const DB_VERSION = 2;

export interface CachedItemRecord {
  /** `${category}::${fileId}` */
  key: string;
  fileId: string;
  category: string;
  title: string;
  body: string;
  imagePath: string;
  imageRawUrl: string;
  jsonPath: string;
  jsonSha: string;
  imageSha: string | null;
  updatedAt: string;
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

export { itemKey } from "./keys";

export async function idbPutItem(record: CachedItemRecord): Promise<void> {
  const db = await openDb();
  const tx = db.transaction("items", "readwrite");
  await reqToPromise(tx.objectStore("items").put(record));
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
  return await reqToPromise(
    tx.objectStore("images").get(itemKey(category, fileId)),
  );
}

export async function idbGetThumb(
  category: string,
  fileId: string,
): Promise<CachedImageRecord | undefined> {
  const db = await openDb();
  if (!db.objectStoreNames.contains("thumbs")) return undefined;
  const tx = db.transaction("thumbs", "readonly");
  return await reqToPromise(
    tx.objectStore("thumbs").get(itemKey(category, fileId)),
  );
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
  const prefix = `${category}::`;

  const collectKeys = async (storeName: string): Promise<Set<string>> => {
    const store = tx.objectStore(storeName);
    const allKeys = await reqToPromise(store.getAllKeys());
    const set = new Set<string>();
    for (const k of allKeys) {
      const s = String(k);
      if (s.startsWith(prefix)) set.add(s.slice(prefix.length));
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
