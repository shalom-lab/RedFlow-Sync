import {
  DEFAULT_BODY_TEMPLATE,
  DEFAULT_CONFIG,
  DEFAULT_DRAFTS_FILE,
  DEFAULT_IMAGES_PATH,
  LEGACY_SOURCE_ID,
  type DataSource,
  type ExtensionConfig,
  type UploadHistory,
} from "@/types";
import { normalizeImportWindow } from "./draft-time";
import { itemKey } from "./keys";
import { normalizePace } from "./pace";
import { normalizeSchedulePlan } from "./schedule";
import {
  createDataSource,
  getActiveSource,
  normalizeDataSource,
  sourceCategory,
} from "./sources";

/** 短暂用过的双端窗口 → 单门槛（from 的前一日末尾） */
function windowFromToAfter(fromDay: string): string {
  const day = fromDay.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return "";
  const d = new Date(`${day}T12:00:00.000Z`);
  if (Number.isNaN(d.getTime())) return "";
  d.setUTCDate(d.getUTCDate() - 1);
  return `${d.toISOString().slice(0, 10)}T23-59-59-999Z`;
}

const CONFIG_KEY = "redflow_config";
const HISTORY_KEY = "redflow_upload_history";
const DAILY_AUTO_DATE_KEY = "redflow_daily_auto_date";
/** 旧版全局导入起点 */
const IMPORT_AFTER_KEY = "redflow_import_after";
/** 按数据源的旧版单门槛 map */
const IMPORT_AFTER_MAP_KEY = "redflow_import_after_by_source";
/** 按数据源的时间筛选窗口 { from, to }（YYYY-MM-DD） */
const IMPORT_WINDOW_MAP_KEY = "redflow_import_window_by_source";
const LEGACY_IDB_MIGRATED_KEY = "redflow_legacy_idb_category_migrated";

function migrateSourcesFromLegacy(
  raw: Record<string, unknown>,
): { sources: DataSource[]; activeSourceId: string } {
  const owner =
    typeof raw.owner === "string" && raw.owner.trim()
      ? raw.owner.trim()
      : DEFAULT_CONFIG.sources[0]!.owner;
  const repo =
    typeof raw.repo === "string" && raw.repo.trim()
      ? raw.repo.trim()
      : DEFAULT_CONFIG.sources[0]!.repo;
  const src = createDataSource({
    id: LEGACY_SOURCE_ID,
    name: `${owner}/${repo}`,
    githubToken: typeof raw.githubToken === "string" ? raw.githubToken : "",
    owner,
    repo,
    basePath:
      typeof raw.basePath === "string" && raw.basePath.trim()
        ? raw.basePath
        : DEFAULT_DRAFTS_FILE,
    imagesPath:
      typeof raw.imagesPath === "string" && raw.imagesPath.trim()
        ? raw.imagesPath
        : DEFAULT_IMAGES_PATH,
  });
  return { sources: [src], activeSourceId: src.id };
}

export function normalizeConfig(
  raw?: Partial<ExtensionConfig> | null,
): ExtensionConfig {
  const bag = (raw ?? {}) as Record<string, unknown>;
  let sources: DataSource[] = [];
  if (Array.isArray(bag.sources)) {
    for (const row of bag.sources) {
      const s = normalizeDataSource(row);
      if (s) sources.push(s);
    }
  }
  let activeSourceId =
    typeof bag.activeSourceId === "string" ? bag.activeSourceId.trim() : "";

  if (!sources.length) {
    const migrated = migrateSourcesFromLegacy(bag);
    sources = migrated.sources;
    activeSourceId = migrated.activeSourceId;
  }

  // 去重 id
  const seen = new Set<string>();
  sources = sources.filter((s) => {
    if (seen.has(s.id)) return false;
    seen.add(s.id);
    return true;
  });

  if (!activeSourceId || !sources.some((s) => s.id === activeSourceId)) {
    activeSourceId = sources[0]!.id;
  }

  const merged: ExtensionConfig = {
    ...DEFAULT_CONFIG,
    ...raw,
    sources,
    activeSourceId,
  };

  merged.dailyAutoPublish = Boolean(merged.dailyAutoPublish);
  {
    const n = Math.floor(Number(merged.dailyAutoCount));
    merged.dailyAutoCount =
      Number.isFinite(n) && n >= 1 ? Math.min(50, n) : DEFAULT_CONFIG.dailyAutoCount;
  }
  merged.compactPublishWindow = Boolean(merged.compactPublishWindow);
  merged.declareAiContent = merged.declareAiContent !== false;
  merged.groupChatEnabled = merged.groupChatEnabled === true;
  merged.quoteNoteEnabled = merged.quoteNoteEnabled === true;
  merged.collectionName =
    merged.collectionName?.trim() || DEFAULT_CONFIG.collectionName;
  merged.groupChatName =
    typeof merged.groupChatName === "string" ? merged.groupChatName.trim() : "";
  merged.requiredTopics =
    merged.requiredTopics?.trim() || DEFAULT_CONFIG.requiredTopics;
  merged.bodyTemplate =
    typeof merged.bodyTemplate === "string" && merged.bodyTemplate.trim()
      ? merged.bodyTemplate
      : DEFAULT_BODY_TEMPLATE;
  merged.submitMode = merged.submitMode === "schedule" ? "schedule" : "draft";
  const plan = normalizeSchedulePlan({
    startHour: merged.scheduleStartHour,
    endHour: merged.scheduleEndHour,
    minLeadHours: merged.scheduleMinLeadHours,
    maxAheadDays: merged.scheduleMaxAheadDays,
  });
  merged.scheduleStartHour = plan.startHour;
  merged.scheduleEndHour = plan.endHour;
  merged.scheduleMinLeadHours = plan.minLeadHours;
  merged.scheduleMaxAheadDays = plan.maxAheadDays;
  merged.pace = normalizePace(merged.pace);
  return merged;
}

export async function getConfig(): Promise<ExtensionConfig> {
  const result = await chrome.storage.local.get(CONFIG_KEY);
  return normalizeConfig(result[CONFIG_KEY] as ExtensionConfig | undefined);
}

export async function saveConfig(config: ExtensionConfig): Promise<void> {
  const normalized = normalizeConfig(config);
  await chrome.storage.local.set({ [CONFIG_KEY]: normalized });
}

export async function getUploadHistory(): Promise<UploadHistory> {
  const result = await chrome.storage.local.get(HISTORY_KEY);
  return (result[HISTORY_KEY] as UploadHistory | undefined) ?? {};
}

export async function markUploaded(
  category: string,
  fileId: string,
): Promise<void> {
  const history = await getUploadHistory();
  const key = itemKey(category, fileId);
  history[key] = {
    uploaded: true,
    uploadedAt: new Date().toISOString(),
  };
  if (history[fileId]) delete history[fileId];
  await chrome.storage.local.set({ [HISTORY_KEY]: history });
}

export function isUploaded(
  history: UploadHistory,
  category: string,
  fileId: string,
): { uploaded: boolean; uploadedAt?: string } {
  const keyed = history[itemKey(category, fileId)];
  if (keyed?.uploaded) {
    return { uploaded: true, uploadedAt: keyed.uploadedAt };
  }
  const legacy = history[fileId];
  if (legacy?.uploaded) {
    return { uploaded: true, uploadedAt: legacy.uploadedAt };
  }
  return { uploaded: false };
}

export function localDateKey(now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

export async function getDailyAutoDate(): Promise<string> {
  const result = await chrome.storage.local.get(DAILY_AUTO_DATE_KEY);
  return String(result[DAILY_AUTO_DATE_KEY] ?? "");
}

export async function setDailyAutoDate(date: string): Promise<void> {
  await chrome.storage.local.set({ [DAILY_AUTO_DATE_KEY]: date });
}

export async function clearDailyAutoDate(): Promise<void> {
  await chrome.storage.local.remove(DAILY_AUTO_DATE_KEY);
}

async function readImportAfterMap(): Promise<Record<string, string>> {
  const result = await chrome.storage.sync.get([
    IMPORT_AFTER_MAP_KEY,
    IMPORT_AFTER_KEY,
    IMPORT_WINDOW_MAP_KEY,
  ]);
  const map = {
    ...((result[IMPORT_AFTER_MAP_KEY] as Record<string, string> | undefined) ??
      {}),
  };
  const legacy = String(result[IMPORT_AFTER_KEY] ?? "").trim();
  if (legacy && !map[LEGACY_SOURCE_ID]) {
    map[LEGACY_SOURCE_ID] = legacy;
  }

  // 若某源只有短暂双端窗口、没有单门槛，折回单门槛
  const winRaw =
    (result[IMPORT_WINDOW_MAP_KEY] as
      | Record<string, { from?: string; to?: string }>
      | undefined) ?? {};
  for (const [sid, raw] of Object.entries(winRaw)) {
    if (map[sid]) continue;
    const win = normalizeImportWindow(raw);
    const after = windowFromToAfter(win.from);
    if (after) map[sid] = after;
  }
  return map;
}

/** 单日门槛：该日及以前不可导；空=不限。上传成功不会改它。 */
export async function getImportAfter(sourceId?: string): Promise<string> {
  const cfg = await getConfig();
  const sid = (sourceId || cfg.activeSourceId || LEGACY_SOURCE_ID).trim();
  const map = await readImportAfterMap();
  return String(map[sid] ?? "").trim();
}

export async function setImportAfter(
  value: string,
  sourceId?: string,
): Promise<void> {
  const cfg = await getConfig();
  const sid = (sourceId || cfg.activeSourceId || LEGACY_SOURCE_ID).trim();
  const map = await readImportAfterMap();
  const v = value.trim();
  if (!v) delete map[sid];
  else map[sid] = v;
  await chrome.storage.sync.set({ [IMPORT_AFTER_MAP_KEY]: map });
  await chrome.storage.sync.remove(IMPORT_AFTER_KEY);
  // 清掉该源的双端窗口残留
  const winResult = await chrome.storage.sync.get(IMPORT_WINDOW_MAP_KEY);
  const winMap = {
    ...((winResult[IMPORT_WINDOW_MAP_KEY] as Record<string, unknown>) ?? {}),
  };
  if (sid in winMap) {
    delete winMap[sid];
    await chrome.storage.sync.set({ [IMPORT_WINDOW_MAP_KEY]: winMap });
  }
}

export async function hasMigratedLegacyIdbCategory(): Promise<boolean> {
  const flag = await chrome.storage.local.get(LEGACY_IDB_MIGRATED_KEY);
  return Boolean(flag[LEGACY_IDB_MIGRATED_KEY]);
}

export async function markLegacyIdbCategoryMigrated(): Promise<void> {
  await chrome.storage.local.set({ [LEGACY_IDB_MIGRATED_KEY]: true });
}

export function parseCategories(raw: string): string[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export { getActiveSource, sourceCategory };
