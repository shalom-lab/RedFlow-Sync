import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import {
  DEFAULT_CONFIG,
  DEFAULT_BODY_TEMPLATE,
  DEFAULT_COLLECTION_NAME,
  DEFAULT_DRAFTS_FILE,
  DEFAULT_IMAGES_PATH,
  DEFAULT_PROMPTS_PATH,
  DEFAULT_REQUIRED_TOPICS,
  formatRepoSlug,
  parseRepoSlug,
  type DataSource,
  type ExtensionConfig,
} from "@/types";
import {
  createDataSource,
  getActiveSource,
  newSourceId,
} from "@/lib/sources";
import {
  AUTO_BATCH_SIZE,
  autoUploadQueue,
  runDraftToXiaohongshuDraft,
  pickOldestPending,
  takeBatchMultiple,
  takeDailyBatch,
  type AutoUploadProgress,
  type DraftUploadInput,
} from "@/lib/auto-upload";
import {
  dateInputToImportAfter,
  formatDraftTime,
  importAfterToDateInput,
  isAfterImportAfter,
  parseDayInput,
} from "@/lib/draft-time";
import { getCategoryList } from "@/lib/github";
import {
  sendRedFlow,
  type CachedItemDTO,
  type SyncStatusDTO,
} from "@/lib/messages";
import {
  getConfig,
  getDailyAutoDate,
  getImportAfter,
  localDateKey,
  normalizeConfig,
  saveConfig,
  setDailyAutoDate,
  setImportAfter,
} from "@/lib/storage";
import { hasGitHubAccess, requestGitHubAccess } from "@/lib/permissions";
import {
  applyCompactPublishWindowNow,
  hasPublishTabOpen,
} from "@/lib/page-bridge";
import { base64ToBlob } from "@/lib/base64";
import {
  DEFAULT_PACE_MS,
  normalizePace,
  PACE_FIELDS,
  PACE_PRESETS,
  type PaceKind,
} from "@/lib/pace";

type TabId = "main" | "history" | "settings";

interface PanelItem extends CachedItemDTO {
  uploaded: boolean;
  uploadedAt: string | null;
}

function isConfigReady(cfg: ExtensionConfig): boolean {
  const src = getActiveSource(cfg);
  return Boolean(src?.owner?.trim() && src?.repo?.trim());
}

function patchActiveSource(
  form: ExtensionConfig,
  patch: Partial<DataSource>,
): ExtensionConfig {
  const activeId = form.activeSourceId;
  const sources = form.sources.map((s) =>
    s.id === activeId ? { ...s, ...patch } : s,
  );
  return normalizeConfig({ ...form, sources });
}

function sortPanelItems(
  list: PanelItem[],
  importAfter: string,
): PanelItem[] {
  return list.slice().sort((a, b) => {
    const aElig = !a.uploaded && isAfterImportAfter(a.fileId, importAfter);
    const bElig = !b.uploaded && isAfterImportAfter(b.fileId, importAfter);
    if (aElig !== bElig) return aElig ? -1 : 1;
    if (a.uploaded !== b.uploaded) return Number(a.uploaded) - Number(b.uploaded);
    return a.fileId.localeCompare(b.fileId, undefined, { numeric: true });
  });
}

function imgBadgeClass(count: number): string {
  if (count <= 0) return "is-unknown";
  if (count === 1) return "is-n1";
  if (count === 2) return "is-n2";
  if (count === 3) return "is-n3";
  return "is-n4";
}

function formatUploadTime(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 16);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function HistoryThumb({
  category,
  fileId,
  enabled,
  onOpen,
}: {
  category: string;
  fileId: string;
  enabled: boolean;
  onOpen: () => void;
}) {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    let obj: string | null = null;
    void (async () => {
      try {
        const res = await sendRedFlow({
          type: "GET_IMAGE",
          category,
          fileId,
          variant: "thumb",
        });
        if (!alive || !res.ok || !("blob" in res) || !res.blob) return;
        const blob = base64ToBlob(res.blob, res.mime);
        obj = URL.createObjectURL(blob);
        if (alive) setUrl(obj);
      } catch {
        /* 无本地图 */
      }
    })();
    return () => {
      alive = false;
      if (obj) URL.revokeObjectURL(obj);
    };
  }, [category, fileId, enabled]);

  if (!url) {
    return <span className="redflow-history-thumb is-empty" aria-hidden />;
  }
  return (
    <button
      type="button"
      className="redflow-history-thumb"
      onClick={onOpen}
      title="查看配图"
    >
      <img src={url} alt="" />
    </button>
  );
}

export function PanelApp() {
  const [tab, setTab] = useState<TabId>("main");
  const [config, setConfig] = useState<ExtensionConfig>(DEFAULT_CONFIG);
  const [settingsForm, setSettingsForm] =
    useState<ExtensionConfig>(DEFAULT_CONFIG);
  const [settingsRepoSlug, setSettingsRepoSlug] = useState("");
  const [category, setCategory] = useState("");
  const [items, setItems] = useState<PanelItem[]>([]);
  const [status, setStatus] = useState<SyncStatusDTO | null>(null);
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [settingsMsg, setSettingsMsg] = useState<string | null>(null);
  const [githubOk, setGithubOk] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [autoRunning, setAutoRunning] = useState(false);
  const [autoPaused, setAutoPaused] = useState(false);
  const [autoProgress, setAutoProgress] = useState<AutoUploadProgress | null>(
    null,
  );
  const [preview, setPreview] = useState<{
    title: string;
    urls: string[];
    index: number;
  } | null>(null);
  const [banner, setBanner] = useState<{
    type: "error" | "info";
    text: string;
  } | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [dangerConfirm, setDangerConfirm] = useState(false);
  const [settingsSyncing, setSettingsSyncing] = useState(false);
  const [sourceDeleteConfirm, setSourceDeleteConfirm] =
    useState<DataSource | null>(null);
  const [importAfter, setImportAfterState] = useState("");
  const [dayDraft, setDayDraft] = useState("");
  const emptyPollRef = useRef(0);
  const toastTimerRef = useRef<number | null>(null);
  const wipeTimerRef = useRef<number | null>(null);
  const loadGenRef = useRef(0);
  const categoryRef = useRef(category);
  const skipConfigReloadRef = useRef(false);
  const itemsRef = useRef<PanelItem[]>([]);
  const busyRef = useRef<string | null>(null);
  const autoRunningRef = useRef(false);
  const dailyKickRef = useRef(false);
  const syncPollRef = useRef<number | null>(null);
  const importAfterRef = useRef("");
  categoryRef.current = category;
  itemsRef.current = items;
  busyRef.current = busyId;
  autoRunningRef.current = autoRunning;
  importAfterRef.current = importAfter;

  /** 测试阶段：错误钉在顶部，不自动消失 */
  const showError = (msg: string) => {
    setBanner({ type: "error", text: msg });
    setToast(null);
  };

  /** 普通进度仍可短提示；失败请用 showError */
  const showToast = (msg: string) => {
    setToast(msg);
    if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
    toastTimerRef.current = window.setTimeout(() => setToast(null), 3200);
  };

  useEffect(() => {
    return () => {
      if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
      if (wipeTimerRef.current) window.clearTimeout(wipeTimerRef.current);
      if (syncPollRef.current) window.clearInterval(syncPollRef.current);
    };
  }, []);

  useEffect(() => {
    const onStorage = (
      changes: { [key: string]: chrome.storage.StorageChange },
      area: string,
    ) => {
      if (area !== "sync" || !changes.redflow_import_after_by_source) return;
      const map =
        (changes.redflow_import_after_by_source.newValue as
          | Record<string, string>
          | undefined) ?? {};
      const sid = config.activeSourceId;
      const next = String(map[sid] ?? "").trim();
      setImportAfterState(next);
      setDayDraft(importAfterToDateInput(next));
      setItems((prev) => sortPanelItems(prev, next));
    };
    chrome.storage.onChanged.addListener(onStorage);
    return () => chrome.storage.onChanged.removeListener(onStorage);
  }, [config.activeSourceId]);

  const applyImportAfter = async (nextRaw: string) => {
    const next = nextRaw.trim();
    await setImportAfter(next, config.activeSourceId);
    setImportAfterState(next);
    setDayDraft(importAfterToDateInput(next));
    setItems((prev) => sortPanelItems(prev, next));
  };

  useEffect(() => {
    setDayDraft(importAfterToDateInput(importAfter));
  }, [importAfter]);

  const commitDayText = async () => {
    const parsed = parseDayInput(dayDraft);
    if (parsed === null) {
      setDayDraft(importAfterToDateInput(importAfter));
      showToast("请输入 YYYY-MM-DD，例如 2026-08-03");
      return;
    }
    await applyImportAfter(parsed ? dateInputToImportAfter(parsed) : "");
  };

  const onDayPickerChange = async (raw: string) => {
    const day = raw.trim();
    await applyImportAfter(day ? dateInputToImportAfter(day) : "");
  };

  const loadFromLocal = useCallback(async (cat: string) => {
    if (!cat) {
      setItems([]);
      return;
    }
    const gen = ++loadGenRef.current;
    setLoading(true);
    setError(null);
    try {
      const res = await sendRedFlow({ type: "GET_LOCAL_ITEMS", category: cat });
      if (gen !== loadGenRef.current) return;
      if (!res.ok || !("items" in res)) {
        setError(!res.ok ? res.error : "读取本地缓存失败");
        setItems([]);
        return;
      }
      setStatus(res.status);
      if (res.status.lastError && !res.items.length) {
        setError(res.status.lastError);
      }
      const mapped: PanelItem[] = res.items.map((it) => ({
        ...it,
        uploaded: Boolean(it.uploaded),
        uploadedAt: it.uploadedAt ?? null,
      }));
      const after = await getImportAfter();
      if (gen !== loadGenRef.current) return;
      setImportAfterState(after);
      setDayDraft(importAfterToDateInput(after));
      setItems(sortPanelItems(mapped, after));

      // 空列表且后台仍在 sync：短暂补拉几次（主清理靠上面的 sync 状态轮询）
      if (
        !mapped.length &&
        res.status.syncing &&
        emptyPollRef.current < 4 &&
        categoryRef.current === cat
      ) {
        emptyPollRef.current += 1;
        window.setTimeout(() => {
          if (categoryRef.current === cat && loadGenRef.current === gen) {
            void loadFromLocal(cat);
          }
        }, 1200);
      } else if (mapped.length || !res.status.syncing) {
        emptyPollRef.current = 0;
      }
    } catch (e) {
      if (gen !== loadGenRef.current) return;
      setError(e instanceof Error ? e.message : String(e));
      setItems([]);
    } finally {
      if (gen === loadGenRef.current) setLoading(false);
    }
  }, []);

  /**
   * 后台 syncing=true 时持续拉状态；结束后关掉横幅并刷新列表。
   * 以前只在空列表时轮询 8 次，同步稍慢或结束后未再拉一次，横幅会一直转。
   */
  useEffect(() => {
    const backgroundSyncing = Boolean(status?.syncing) && !syncing;
    if (!backgroundSyncing) {
      if (syncPollRef.current) {
        window.clearInterval(syncPollRef.current);
        syncPollRef.current = null;
      }
      return;
    }

    let cancelled = false;
    let ticks = 0;
    const MAX_TICKS = 90; // ~90s

    const tick = async () => {
      if (cancelled) return;
      ticks += 1;
      try {
        const res = await sendRedFlow({ type: "GET_SYNC_STATUS" });
        if (cancelled || !res.ok || !("status" in res)) return;
        setStatus(res.status);
        if (!res.status.syncing) {
          if (syncPollRef.current) {
            window.clearInterval(syncPollRef.current);
            syncPollRef.current = null;
          }
          const cat = categoryRef.current;
          if (cat) void loadFromLocal(cat);
          return;
        }
      } catch {
        /* ignore */
      }
      if (ticks >= MAX_TICKS) {
        setStatus((prev) => (prev ? { ...prev, syncing: false } : prev));
        if (syncPollRef.current) {
          window.clearInterval(syncPollRef.current);
          syncPollRef.current = null;
        }
      }
    };

    void tick();
    syncPollRef.current = window.setInterval(() => void tick(), 1000);
    return () => {
      cancelled = true;
      if (syncPollRef.current) {
        window.clearInterval(syncPollRef.current);
        syncPollRef.current = null;
      }
    };
  }, [status?.syncing, syncing, loadFromLocal]);

  const applyConfig = useCallback(
    async (cfg: ExtensionConfig, preferCat?: string) => {
      setConfig(cfg);
      setSettingsForm(cfg);
      const src = getActiveSource(cfg);
      setSettingsRepoSlug(
        src ? formatRepoSlug(src.owner, src.repo) : "",
      );
      const cats = getCategoryList(cfg);
      const nextCat =
        preferCat && cats.includes(preferCat) ? preferCat : (cats[0] ?? "");
      setCategory(nextCat);
      const after = await getImportAfter(cfg.activeSourceId);
      setImportAfterState(after);
      setDayDraft(importAfterToDateInput(after));
      if (!isConfigReady(cfg)) {
        setTab("settings");
        setItems([]);
        return;
      }
      if (nextCat) await loadFromLocal(nextCat);
    },
    [loadFromLocal],
  );

  const bootstrap = useCallback(async () => {
    const cfg = await getConfig();
    const granted = await hasGitHubAccess();
    setGithubOk(granted);
    await applyConfig(cfg);
  }, [applyConfig]);

  const switchActiveSource = async (sourceId: string) => {
    if (sourceId === config.activeSourceId) return;
    if (autoRunningRef.current || busyRef.current) {
      showToast("自动化进行中，请稍后再切换数据源");
      return;
    }
    const next = normalizeConfig({ ...config, activeSourceId: sourceId });
    skipConfigReloadRef.current = true;
    await saveConfig(next);
    await applyConfig(next);
    showToast(
      `已切换到 ${getActiveSource(next)?.name || sourceId}`,
    );
  };

  useEffect(() => {
    void bootstrap();
    const onChange = (
      changes: { [key: string]: chrome.storage.StorageChange },
      area: string,
    ) => {
      if (area === "local" && changes.redflow_config) {
        if (skipConfigReloadRef.current) {
          skipConfigReloadRef.current = false;
          return;
        }
        void bootstrap();
      }
    };
    chrome.storage.onChanged.addListener(onChange);
    return () => chrome.storage.onChanged.removeListener(onChange);
  }, [bootstrap]);

  const onRefresh = async () => {
    if (!isConfigReady(config)) {
      setTab("settings");
      showToast("请先在设置填写仓库配置");
      return;
    }
    const granted = await requestGitHubAccess();
    setGithubOk(granted);
    if (!granted) {
      setTab("settings");
      showToast("请在弹窗中允许 GitHub 访问");
      return;
    }
    setSyncing(true);
    setError(null);
    try {
      const res = await sendRedFlow({
        type: "SYNC_NOW",
        reason: "panel-refresh",
      });
      if (!res.ok) {
        setError(res.error);
        showError(res.error);
        setStatus((prev) =>
          prev ? { ...prev, syncing: false } : prev,
        );
      } else {
        if ("status" in res) {
          setStatus({ ...res.status, syncing: false });
        }
        const r = "result" in res ? res.result : undefined;
        showToast(
          r ? `已同步草稿 ${r.fetchedJson} 条（配图导入时再下）` : "同步完成",
        );
      }
      if (category) await loadFromLocal(category);
    } finally {
      setSyncing(false);
    }
  };

  const onImport = async (item: PanelItem) => {
    if (busyId != null || autoRunning) return;
    setBusyId(item.fileId);
    showToast(
      config.submitMode === "schedule"
        ? "正在处理：拉图 → 填表 → 定时发布…"
        : "正在处理：拉图 → 填表 → 暂存离开…",
    );
    try {
      const result = await runDraftToXiaohongshuDraft({
        category: item.category,
        fileId: item.fileId,
        title: item.title,
        keywords: item.keywords ?? [],
        replyKeyword: item.replyKeyword,
        imageRawUrl: item.imageRawUrl || undefined,
      });

      if (result.ok) {
        const uploadedAt = new Date().toISOString();
        const after = await getImportAfter();
        setImportAfterState(after);
        setItems((prev) =>
          sortPanelItems(
            prev.map((x) =>
              x.fileId === item.fileId && x.category === item.category
                ? { ...x, uploaded: true, uploadedAt, hasImage: true }
                : x,
            ),
            after,
          ),
        );
        const sched = result.steps?.scheduledAt
          ? `，定时 ${result.steps.scheduledAt}`
          : "";
        const tip = result.steps?.draftSaved
          ? result.steps?.scheduledAt
            ? `已定时发布 ${item.fileId}${sched}`
            : `已暂存离开 ${item.fileId}`
          : `已填入 ${item.fileId}${sched}（请确认底部按钮）`;
        if (result.error) {
          showError(`${tip}；附带警告：${result.error}`);
        } else {
          showToast(tip);
          setBanner(null);
        }
      } else {
        showError(`失败：${result.error ?? "未知错误"}`);
      }
    } catch (e) {
      showError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  };

  const toUploadInputs = (list: PanelItem[]): Array<DraftUploadInput & { uploaded?: boolean }> =>
    list.map((it) => ({
      category: it.category,
      fileId: it.fileId,
      title: it.title,
      keywords: it.keywords ?? [],
      replyKeyword: it.replyKeyword,
      imageRawUrl: it.imageRawUrl || undefined,
      uploaded: it.uploaded,
    }));

  const runAutoQueue = async (
    mode: "manual" | "daily",
    queue: DraftUploadInput[],
  ) => {
    if (autoUploadQueue.isRunning || autoRunningRef.current || busyRef.current) {
      return;
    }
    setAutoRunning(true);
    setAutoPaused(false);
    const batchSize =
      mode === "daily"
        ? Math.max(1, queue.length)
        : AUTO_BATCH_SIZE;
    setAutoProgress({
      current: 0,
      total: queue.length,
      batchNo: 1,
      batchCount: Math.max(1, Math.ceil(queue.length / batchSize)),
      batchIndex: 0,
      batchSize,
      title: mode === "daily" ? "每日自动排队中" : "排队中",
      fileId: "",
    });
    showToast(
      mode === "daily"
        ? `每日自动：开始今天的 ${queue.length} 篇`
        : `开始自动化：${queue.length} 篇（${queue.length / AUTO_BATCH_SIZE} 批 × ${AUTO_BATCH_SIZE}）`,
    );

    await autoUploadQueue.start(queue, {
      onItemStart: (item, _index, _total, progress) => {
        setBusyId(item.fileId);
        setAutoProgress(progress);
      },
      onItemDone: (item, result, _index, progress) => {
        setAutoProgress(progress);
        if (result.ok) {
          const uploadedAt = new Date().toISOString();
          void getImportAfter().then((after) => {
            setImportAfterState(after);
            setItems((prev) =>
              sortPanelItems(
                prev.map((x) =>
                  x.fileId === item.fileId && x.category === item.category
                    ? { ...x, uploaded: true, uploadedAt, hasImage: true }
                    : x,
                ),
                after,
              ),
            );
          });
          if (result.error) {
            showError(`${item.fileId} 已处理，但有警告：${result.error}`);
          }
        } else {
          showError(`自动失败 [${item.fileId}]：${result.error ?? "未知错误"}`);
        }
        setBusyId(null);
      },
      onStop: (reason, detail) => {
        setAutoRunning(false);
        setAutoPaused(reason === "paused");
        setBusyId(null);
        if (reason !== "paused") setAutoProgress(null);
        if (mode === "daily") {
          void setDailyAutoDate(localDateKey());
        }
        if (reason === "paused") showToast(detail || "已暂停（本批 5 篇已跑完）");
        else if (reason === "done") {
          showToast(
            mode === "daily"
              ? detail || "今日 5 篇已完成，已自动停止"
              : detail || "自动化全部完成",
          );
        } else showError(detail || "自动化已停止");
      },
    });
  };

  const onStartAuto = async () => {
    if (autoRunning || busyId != null || autoUploadQueue.isRunning) return;
    if (!isConfigReady(config)) {
      setTab("settings");
      showToast("请先配置仓库");
      return;
    }
    const pending = pickOldestPending(
      toUploadInputs(items),
      importAfterRef.current,
    );
    if (!pending.length) {
      showToast("没有可导入的草稿（检查时间筛选）");
      return;
    }
    const queue = takeBatchMultiple(pending, AUTO_BATCH_SIZE);
    if (!queue.length) {
      showError(
        `未满 ${AUTO_BATCH_SIZE} 篇（待处理 ${pending.length} 条）。自动化一次只跑 ${AUTO_BATCH_SIZE} 的倍数，请攒够再开始。`,
      );
      return;
    }
    await runAutoQueue("manual", queue);
  };

  const closePreview = () => {
    setPreview((prev) => {
      if (prev) prev.urls.forEach((u) => URL.revokeObjectURL(u));
      return null;
    });
  };

  const stepPreview = (delta: number) => {
    setPreview((prev) => {
      if (!prev || prev.urls.length <= 1) return prev;
      const n = prev.urls.length;
      const index = (prev.index + delta + n) % n;
      return { ...prev, index };
    });
  };

  const openHistoryPreview = async (item: PanelItem) => {
    closePreview();
    try {
      const res = await sendRedFlow({
        type: "GET_IMAGES",
        category: item.category,
        fileId: item.fileId,
      });
      if (!res.ok || !("blobs" in res) || !res.blobs.length) {
        showToast("这条还没有本地配图");
        return;
      }
      const urls = res.blobs.map((b) =>
        URL.createObjectURL(base64ToBlob(b.base64, b.mime || "image/png")),
      );
      setPreview({ title: item.title, urls, index: 0 });
    } catch (e) {
      showError(e instanceof Error ? e.message : String(e));
    }
  };

  useEffect(() => {
    if (!preview) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        closePreview();
        return;
      }
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        stepPreview(-1);
        return;
      }
      if (e.key === "ArrowRight") {
        e.preventDefault();
        stepPreview(1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [preview]);

  const onPauseAuto = () => {
    if (!autoRunning) return;
    autoUploadQueue.pause();
    setAutoPaused(true);
    showToast("将在本批 5 篇结束后暂停");
  };

  const persistSettingsPatch = (patch: Partial<ExtensionConfig>) => {
    setSettingsForm((prev) => {
      const next = normalizeConfig({ ...prev, ...patch });
      skipConfigReloadRef.current = true;
      void saveConfig(next).then(() => setConfig(next));
      return next;
    });
    setSettingsMsg(null);
  };

  const persistPaceField = (key: PaceKind, raw: string) => {
    persistSettingsPatch({
      pace: normalizePace({
        ...settingsForm.pace,
        [key]: Number(raw),
      }),
    });
  };

  const applyPacePreset = (pace: typeof DEFAULT_PACE_MS) => {
    persistSettingsPatch({ pace: normalizePace(pace) });
  };

  const buildSettingsConfig = (): ExtensionConfig | null => {
    const parsed = parseRepoSlug(settingsRepoSlug);
    if (!parsed) {
      setSettingsMsg("仓库请填写为 owner/repo");
      return null;
    }
    const editing = getActiveSource(settingsForm);
    if (!editing) {
      setSettingsMsg("请先添加一个数据源");
      return null;
    }

    const updatedSource: DataSource = {
      ...editing,
      owner: parsed.owner,
      repo: parsed.repo,
      basePath:
        editing.basePath.trim().replace(/^\/+|\/+$/g, "") ||
        DEFAULT_DRAFTS_FILE,
      imagesPath:
        editing.imagesPath.trim().replace(/^\/+|\/+$/g, "") ||
        DEFAULT_IMAGES_PATH,
      name:
        editing.name.trim() ||
        formatRepoSlug(parsed.owner, parsed.repo) ||
        "数据源",
      githubToken: editing.githubToken.trim(),
    };

    return normalizeConfig({
      ...settingsForm,
      sources: settingsForm.sources.map((s) =>
        s.id === updatedSource.id ? updatedSource : s,
      ),
      activeSourceId: updatedSource.id,
      dailyAutoPublish: Boolean(settingsForm.dailyAutoPublish),
      dailyAutoCount: settingsForm.dailyAutoCount,
      compactPublishWindow: Boolean(settingsForm.compactPublishWindow),
      submitMode:
        settingsForm.submitMode === "schedule" ? "schedule" : "draft",
      scheduleStartHour: settingsForm.scheduleStartHour,
      scheduleEndHour: settingsForm.scheduleEndHour,
      scheduleMinLeadHours: settingsForm.scheduleMinLeadHours,
      scheduleMaxAheadDays: settingsForm.scheduleMaxAheadDays,
      pace: normalizePace(settingsForm.pace),
      declareAiContent: settingsForm.declareAiContent !== false,
      collectionName:
        settingsForm.collectionName.trim() || DEFAULT_COLLECTION_NAME,
      groupChatEnabled: settingsForm.groupChatEnabled === true,
      groupChatName: settingsForm.groupChatName.trim(),
      quoteNoteEnabled: settingsForm.quoteNoteEnabled === true,
      requiredTopics:
        settingsForm.requiredTopics.trim() || DEFAULT_REQUIRED_TOPICS,
      bodyTemplate:
        settingsForm.bodyTemplate.trim() || DEFAULT_BODY_TEMPLATE,
    });
  };

  const onSaveSettings = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setSettingsMsg(null);
    try {
      const next = buildSettingsConfig();
      if (!next) return;

      skipConfigReloadRef.current = true;
      const granted = await requestGitHubAccess();
      setGithubOk(granted);
      await saveConfig(next);
      await applyConfig(next);

      if (!granted) {
        setSettingsMsg("配置已保存。请再次点保存，并在弹窗中允许 GitHub 访问");
        showToast("需授权 GitHub 访问");
        return;
      }

      setSettingsMsg("配置已保存（未同步；需要时点「同步草稿」）");
      showToast("配置已保存");
    } finally {
      setSaving(false);
    }
  };

  const onSyncFromSettings = async () => {
    if (settingsSyncing || saving || syncing || status?.syncing) return;
    setSettingsSyncing(true);
    setSettingsMsg(null);
    try {
      const next = buildSettingsConfig();
      if (!next) return;
      skipConfigReloadRef.current = true;
      const granted = await requestGitHubAccess();
      setGithubOk(granted);
      await saveConfig(next);
      await applyConfig(next);
      if (!granted) {
        setSettingsMsg("请先允许 GitHub 访问后再同步");
        showToast("需授权 GitHub 访问");
        return;
      }
      if (!isConfigReady(next)) {
        setSettingsMsg("请先配置仓库再同步");
        return;
      }

      setSettingsMsg("正在同步草稿索引…");
      setSyncing(true);
      const syncRes = await sendRedFlow({
        type: "SYNC_NOW",
        reason: "settings-sync",
      });
      if (!syncRes.ok) {
        setSettingsMsg(`同步失败：${syncRes.error}`);
        showError(syncRes.error);
        setStatus((prev) => (prev ? { ...prev, syncing: false } : prev));
      } else {
        if ("status" in syncRes) {
          setStatus({ ...syncRes.status, syncing: false });
        }
        const r = "result" in syncRes ? syncRes.result : undefined;
        setSettingsMsg(
          r ? `已同步草稿 ${r.fetchedJson} 条` : "草稿索引已同步",
        );
        showToast(r ? `已同步草稿 ${r.fetchedJson} 条` : "同步完成");
        const cats = getCategoryList(next);
        if (cats[0]) await loadFromLocal(cats[0]);
      }
    } finally {
      setSyncing(false);
      setSettingsSyncing(false);
    }
  };

  const askWipeDrafts = () => {
    setDangerConfirm(true);
    if (wipeTimerRef.current) window.clearTimeout(wipeTimerRef.current);
    wipeTimerRef.current = window.setTimeout(
      () => setDangerConfirm(false),
      8000,
    );
  };

  const onConfirmWipeAll = async () => {
    if (wipeTimerRef.current) window.clearTimeout(wipeTimerRef.current);
    setDangerConfirm(false);
    autoUploadQueue.pause();
    try {
      const res = await sendRedFlow({ type: "WIPE_ALL_DATA" });
      if (!res.ok) {
        setSettingsMsg(`清空失败：${res.error}`);
        showError(res.error);
        return;
      }
      setItems([]);
      if ("status" in res) setStatus(res.status);
      setSettingsMsg("已清空草稿列表，正在重新同步…");
      showToast("草稿列表已清空；已传记录仍保留");
      if (!isConfigReady(config)) return;
      setSyncing(true);
      const syncRes = await sendRedFlow({
        type: "SYNC_NOW",
        reason: "wipe-redraft",
      });
      if (!syncRes.ok) {
        setSettingsMsg(`列表已清空，重新同步失败：${syncRes.error}`);
        showError(syncRes.error);
      } else {
        if ("status" in syncRes) setStatus(syncRes.status);
        const r = "result" in syncRes ? syncRes.result : undefined;
        setSettingsMsg(
          r
            ? `草稿列表已重建，同步 ${r.fetchedJson} 条（已传 id 已合并）`
            : "草稿列表已清空并重新同步",
        );
        showToast(
          r ? `已重新同步草稿 ${r.fetchedJson} 条` : "已重新同步草稿",
        );
        if (category) await loadFromLocal(category);
      }
    } catch (e) {
      showError(e instanceof Error ? e.message : String(e));
    } finally {
      setSyncing(false);
    }
  };

  useEffect(() => {
    if (!config.dailyAutoPublish) return;
    const dailyCount = Math.max(1, Math.floor(config.dailyAutoCount) || 5);
    let cancelled = false;
    const tick = async () => {
      if (cancelled || dailyKickRef.current) return;
      if (autoRunningRef.current || busyRef.current || autoUploadQueue.isRunning) {
        return;
      }
      const last = await getDailyAutoDate();
      if (last === localDateKey()) return;
      if (!(await hasPublishTabOpen())) return;
      const pending = pickOldestPending(
        toUploadInputs(itemsRef.current),
        importAfterRef.current,
      );
      const queue = takeDailyBatch(pending, dailyCount);
      if (!queue.length) return;
      dailyKickRef.current = true;
      try {
        await runAutoQueue("daily", queue);
      } finally {
        dailyKickRef.current = false;
      }
    };
    void tick();
    const id = window.setInterval(() => void tick(), 5000);
    const onTab = () => {
      void tick();
    };
    chrome.tabs.onUpdated.addListener(onTab);
    chrome.tabs.onActivated.addListener(onTab);
    return () => {
      cancelled = true;
      window.clearInterval(id);
      chrome.tabs.onUpdated.removeListener(onTab);
      chrome.tabs.onActivated.removeListener(onTab);
    };
  }, [config.dailyAutoPublish, config.dailyAutoCount]);

  const showSyncChrome = syncing || Boolean(status?.syncing);
  const uploadedCount = items.filter((i) => i.uploaded).length;
  const pendingCount = items.filter((i) => !i.uploaded).length;
  const eligibleCount = items.filter(
    (i) => !i.uploaded && isAfterImportAfter(i.fileId, importAfter),
  ).length;
  const dayValue = importAfterToDateInput(importAfter);

  return (
    <aside
      className={`redflow-panel ${showSyncChrome ? "is-syncing" : ""}`}
      aria-label="RedFlow-Sync"
    >
      {showSyncChrome && <div className="redflow-sync-bar" aria-hidden />}

      {banner && (
        <div
          className={`redflow-debug-banner is-${banner.type}`}
          role={banner.type === "error" ? "alert" : "status"}
        >
          <pre className="redflow-debug-banner-text">{banner.text}</pre>
          <button
            type="button"
            className="redflow-debug-banner-close"
            onClick={() => setBanner(null)}
            title="关闭"
          >
            ×
          </button>
        </div>
      )}

      {showSyncChrome && tab === "main" && (
        <div className="redflow-sync-banner" role="status">
          <span className="redflow-spinner" aria-hidden />
          <div>
            <strong>同步进行中</strong>
            <p>仅同步草稿索引 JSON，配图在导入时按条下载</p>
          </div>
        </div>
      )}

      <nav className="redflow-tabs" aria-label="面板切换">
        <button
          type="button"
          className={`redflow-tab ${tab === "main" ? "is-active" : ""}`}
          onClick={() => setTab("main")}
        >
          主页
        </button>
        <button
          type="button"
          className={`redflow-tab ${tab === "history" ? "is-active" : ""}`}
          onClick={() => setTab("history")}
        >
          历史
        </button>
        <button
          type="button"
          className={`redflow-tab ${tab === "settings" ? "is-active" : ""}`}
          onClick={() => setTab("settings")}
        >
          设置
        </button>
      </nav>

      {tab === "main" ? (
        <>
          <div className="redflow-toolbar">
            <div className="redflow-toolbar-top">
              <label className="redflow-source-combo">
                <span className="redflow-source-combo-tag">数据源</span>
                <select
                  className="redflow-source-combo-select"
                  value={config.activeSourceId}
                  disabled={showSyncChrome || autoRunning}
                  onChange={(e) => void switchActiveSource(e.target.value)}
                >
                  {config.sources.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name || formatRepoSlug(s.owner, s.repo)}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <p className="redflow-toolbar-stats">
              {items.length
                ? `可导 ${eligibleCount} · 未传 ${pendingCount} · 已传 ${uploadedCount}（共 ${items.length}）`
                : "同步后显示"}
              {autoProgress
                ? ` · 自动 ${autoProgress.current}/${autoProgress.total}`
                : ""}
            </p>
          </div>

          <div className="redflow-cutoff-bar">
            <div className="redflow-day-row">
              <span className="redflow-cutoff-title">时间筛选</span>
              <div className="redflow-day-field">
                <input
                  type="text"
                  className="redflow-day-input"
                  inputMode="numeric"
                  placeholder="YYYY-MM-DD"
                  spellCheck={false}
                  value={dayDraft}
                  disabled={showSyncChrome || autoRunning}
                  title="该日及以前不可导；留空不限。可手输或点右侧日历。上传不会改这里"
                  onChange={(e) => setDayDraft(e.target.value)}
                  onBlur={() => void commitDayText()}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      (e.target as HTMLInputElement).blur();
                    }
                  }}
                />
                <input
                  type="date"
                  className="redflow-day-picker"
                  value={dayValue}
                  disabled={showSyncChrome || autoRunning}
                  title="点选日期"
                  onChange={(e) => void onDayPickerChange(e.target.value)}
                />
              </div>
              <button
                type="button"
                className="redflow-range-reset"
                disabled={showSyncChrome || autoRunning || !importAfter}
                onClick={() => void applyImportAfter("")}
                title="清除日期限制"
              >
                全部
              </button>
            </div>
          </div>

          {(autoRunning || autoPaused) && (
            <div className="redflow-auto-banner" role="status">
              {autoRunning && autoPaused ? (
                <>
                  <strong>即将暂停</strong>
                  <p>本批 5 篇跑完后停止。进度 {autoProgress ? `${autoProgress.current}/${autoProgress.total}` : ""}</p>
                </>
              ) : autoRunning && autoProgress ? (
                <>
                  <strong>
                    自动化 {autoProgress.current}/{autoProgress.total}
                  </strong>
                  <p>
                    第 {autoProgress.batchNo}/{autoProgress.batchCount} 批 · 本批{" "}
                    {autoProgress.batchIndex}/{autoProgress.batchSize}
                    {autoProgress.title
                      ? ` · ${autoProgress.title.slice(0, 24)}`
                      : ""}
                    {autoProgress.scheduledAt
                      ? ` · 定时 ${autoProgress.scheduledAt}`
                      : ""}
                  </p>
                </>
              ) : (
                <strong>已暂停</strong>
              )}
            </div>
          )}

          <div className="redflow-list">
            {!isConfigReady(config) && (
              <div className="redflow-empty">
                尚未配置数据源
                <button
                  type="button"
                  className="redflow-link-btn"
                  onClick={() => setTab("settings")}
                >
                  去设置填写
                </button>
              </div>
            )}
            {isConfigReady(config) && showSyncChrome && !items.length && (
              <div className="redflow-empty redflow-empty-sync">
                <span className="redflow-spinner redflow-spinner-lg" aria-hidden />
                <p>正在拉取草稿索引…</p>
              </div>
            )}
            {isConfigReady(config) && loading && !showSyncChrome && !items.length && (
              <div className="redflow-empty">加载本地缓存…</div>
            )}
            {isConfigReady(config) && !loading && error && (
              <div className="redflow-error">{error}</div>
            )}
            {isConfigReady(config) &&
              !loading &&
              !error &&
              !items.length &&
              !showSyncChrome && (
                <div className="redflow-empty">
                  本地暂无草稿，点底部「同步」拉取 wechat_newspic_drafts.json
                </div>
              )}
            {items.map((item) => {
              const beforeCutoff =
                !item.uploaded && !isAfterImportAfter(item.fileId, importAfter);
              const imgCount = Math.max(0, Number(item.imageCount) || 0);
              return (
              <article
                key={`${item.category}::${item.fileId}`}
                className={`redflow-row ${item.uploaded ? "is-synced" : ""} ${beforeCutoff ? "is-before-cutoff" : ""}`}
              >
                <div className="redflow-row-body">
                  <h3 className="redflow-row-title" title={item.title}>
                    {item.title}
                  </h3>
                  <time className="redflow-time" title={item.fileId}>
                    {formatDraftTime(item.fileId)}
                  </time>
                </div>
                <div className="redflow-row-action">
                  <span
                    className={`redflow-img-badge ${imgBadgeClass(imgCount)}`}
                    title={
                      imgCount > 0
                        ? `${imgCount} 张配图`
                        : "配图张数未知（导入时再拉）"
                    }
                  >
                    {imgCount > 0 ? imgCount : "—"}
                  </span>
                  {item.uploaded ? (
                    <span
                      className="redflow-badge"
                      title={item.uploadedAt ?? ""}
                    >
                      已导入
                    </span>
                  ) : (
                    <button
                      type="button"
                      className="redflow-btn redflow-btn-sm"
                      disabled={
                        beforeCutoff ||
                        busyId != null ||
                        showSyncChrome ||
                        autoRunning
                      }
                      title={
                        beforeCutoff
                          ? "早于时间筛选日期，调整后可导入"
                          : undefined
                      }
                      onClick={() => void onImport(item)}
                    >
                      {busyId === item.fileId ? "处理中…" : "导入"}
                    </button>
                  )}
                </div>
              </article>
              );
            })}
          </div>

          <footer className="redflow-footer redflow-footer-multi">
            <button
              type="button"
              className="redflow-btn"
              disabled={
                showSyncChrome ||
                !isConfigReady(config) ||
                autoRunning ||
                busyId != null
              }
              onClick={() => void onStartAuto()}
            >
              开始自动化
            </button>
            <button
              type="button"
              className="redflow-btn redflow-btn-ghost"
              disabled={!autoRunning || autoPaused}
              onClick={onPauseAuto}
            >
              暂停
            </button>
            <button
              type="button"
              className="redflow-btn redflow-btn-ghost"
              disabled={showSyncChrome || !isConfigReady(config) || autoRunning}
              onClick={() => void onRefresh()}
            >
              {showSyncChrome ? (
                <>
                  <span
                    className="redflow-spinner redflow-spinner-btn"
                    aria-hidden
                  />
                  同步中…
                </>
              ) : (
                "同步仓库"
              )}
            </button>
          </footer>
        </>
      ) : tab === "history" ? (
        <>
          <div className="redflow-toolbar">
            <span className="redflow-label">已上传</span>
            <span className="redflow-muted">
              {items.filter((i) => i.uploaded).length} 条 · 点缩略图看原图
            </span>
          </div>
          <div className="redflow-history-list">
            {items.filter((i) => i.uploaded).length === 0 ? (
              <div className="redflow-empty">还没有已上传记录</div>
            ) : (
              items
                .filter((i) => i.uploaded)
                .slice()
                .sort((a, b) =>
                  (b.uploadedAt || "").localeCompare(a.uploadedAt || ""),
                )
                .map((item) => (
                  <article
                    key={`${item.category}::${item.fileId}`}
                    className="redflow-history-row"
                  >
                    <HistoryThumb
                      category={item.category}
                      fileId={item.fileId}
                      enabled={item.hasImage || item.hasThumb}
                      onOpen={() => void openHistoryPreview(item)}
                    />
                    <div className="redflow-history-meta">
                      <h3 className="redflow-history-title" title={item.title}>
                        {item.title}
                      </h3>
                      <p className="redflow-history-time">
                        {formatUploadTime(item.uploadedAt) ||
                          formatDraftTime(item.fileId)}
                      </p>
                    </div>
                  </article>
                ))
            )}
          </div>
        </>
      ) : (
        <form
          className="redflow-settings"
          onSubmit={(e) => void onSaveSettings(e)}
        >
          <section className="redflow-settings-section">
            <h3 className="redflow-settings-title">GitHub 数据源</h3>
            <p className="redflow-settings-hint">
              可添加多个仓库，每套独立令牌；同步/导入只针对当前源。分支自动用仓库默认分支。
              导入时再读{" "}
              <code>{DEFAULT_PROMPTS_PATH}/&#123;id&#125;.json</code> 与配图目录。
            </p>

            <label className="redflow-label redflow-source-edit-label">
              当前编辑
              <div className="redflow-source-edit-controls">
                <select
                  className="redflow-input redflow-source-edit-select"
                  value={settingsForm.activeSourceId}
                  onChange={(e) => {
                    const id = e.target.value;
                    const next = normalizeConfig({
                      ...settingsForm,
                      activeSourceId: id,
                    });
                    setSettingsForm(next);
                    const src = getActiveSource(next);
                    setSettingsRepoSlug(
                      src ? formatRepoSlug(src.owner, src.repo) : "",
                    );
                    setSettingsMsg(null);
                  }}
                >
                  {settingsForm.sources.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name || formatRepoSlug(s.owner, s.repo)}
                    </option>
                  ))}
                </select>
                <div className="redflow-source-actions">
                  <button
                    type="button"
                    className="redflow-icon-btn"
                    title="添加数据源"
                    aria-label="添加数据源"
                    onClick={() => {
                      const src = createDataSource({
                        id: newSourceId(),
                        name: "新数据源",
                        owner: "owner",
                        repo: "repo",
                      });
                      const next = normalizeConfig({
                        ...settingsForm,
                        sources: [...settingsForm.sources, src],
                        activeSourceId: src.id,
                      });
                      setSettingsForm(next);
                      setSettingsRepoSlug(formatRepoSlug(src.owner, src.repo));
                      setSettingsMsg("已添加数据源，请填写令牌与仓库后保存");
                    }}
                  >
                    <span aria-hidden>+</span>
                  </button>
                  <button
                    type="button"
                    className="redflow-icon-btn redflow-icon-btn-danger"
                    title="删除当前数据源"
                    aria-label="删除当前数据源"
                    disabled={settingsForm.sources.length <= 1}
                    onClick={() => {
                      if (settingsForm.sources.length <= 1) return;
                      const src = getActiveSource(settingsForm);
                      if (src) setSourceDeleteConfirm(src);
                    }}
                  >
                    <span aria-hidden>×</span>
                  </button>
                </div>
              </div>
            </label>

            {(() => {
              const src = getActiveSource(settingsForm);
              if (!src) return null;
              return (
                <>
                  <label className="redflow-label">
                    显示名称
                    <input
                      className="redflow-input"
                      placeholder="InfoFlow"
                      value={src.name}
                      onChange={(e) => {
                        setSettingsForm(
                          patchActiveSource(settingsForm, {
                            name: e.target.value,
                          }),
                        );
                        setSettingsMsg(null);
                      }}
                    />
                  </label>

                  <label className="redflow-label">
                    GitHub 令牌
                    <input
                      className="redflow-input"
                      type="password"
                      autoComplete="off"
                      placeholder="私有仓必填 ghp_..."
                      value={src.githubToken}
                      onChange={(e) => {
                        setSettingsForm(
                          patchActiveSource(settingsForm, {
                            githubToken: e.target.value,
                          }),
                        );
                        setSettingsMsg(null);
                      }}
                    />
                  </label>

                  <label className="redflow-label">
                    仓库（owner/repo）
                    <input
                      className="redflow-input"
                      required
                      placeholder="shalom-lab/InfoFlow"
                      value={settingsRepoSlug}
                      onChange={(e) => {
                        setSettingsRepoSlug(e.target.value);
                        setSettingsMsg(null);
                      }}
                    />
                  </label>

                  <label className="redflow-label">
                    草稿索引文件
                    <input
                      className="redflow-input"
                      placeholder={DEFAULT_DRAFTS_FILE}
                      value={src.basePath}
                      onChange={(e) => {
                        setSettingsForm(
                          patchActiveSource(settingsForm, {
                            basePath: e.target.value,
                          }),
                        );
                        setSettingsMsg(null);
                      }}
                    />
                  </label>

                  <label className="redflow-label">
                    图片目录
                    <input
                      className="redflow-input"
                      placeholder={DEFAULT_IMAGES_PATH}
                      value={src.imagesPath}
                      onChange={(e) => {
                        setSettingsForm(
                          patchActiveSource(settingsForm, {
                            imagesPath: e.target.value,
                          }),
                        );
                        setSettingsMsg(null);
                      }}
                    />
                  </label>
                </>
              );
            })()}

            <p className="redflow-perm-line">
              GitHub 权限：{githubOk ? "已授予" : "未授予"}
              {status?.itemCount != null ? ` · 本地合计 ${status.itemCount} 条` : ""}
              {" · 分支：仓库默认分支"}
            </p>
          </section>

          <section className="redflow-settings-section">
            <h3 className="redflow-settings-title">提交方式</h3>
            <div className="redflow-mode-row">
              <label
                className={`redflow-mode-card${
                  settingsForm.submitMode !== "schedule" ? " is-on" : ""
                }`}
              >
                <input
                  type="radio"
                  name="submitMode"
                  checked={settingsForm.submitMode !== "schedule"}
                  onChange={() => persistSettingsPatch({ submitMode: "draft" })}
                />
                <span>
                  <strong>存草稿</strong>
                  不勾选定时，点白色「暂存离开」
                </span>
              </label>
              <label
                className={`redflow-mode-card${
                  settingsForm.submitMode === "schedule" ? " is-on" : ""
                }`}
              >
                <input
                  type="radio"
                  name="submitMode"
                  checked={settingsForm.submitMode === "schedule"}
                  onChange={() =>
                    persistSettingsPatch({ submitMode: "schedule" })
                  }
                />
                <span>
                  <strong>定时发布</strong>
                  勾选定时并填时间，点红色「定时发布」
                </span>
              </label>
            </div>
            {settingsForm.submitMode === "schedule" ? (
              <div className="redflow-schedule-box">
                <p className="redflow-settings-hint">
                  勾选定时后必须填写这些项。时间在区间内随机。
                </p>
                <div className="redflow-settings-row">
                  <label className="redflow-label">
                    可发开始（时）
                    <input
                      className="redflow-input"
                      type="number"
                      min={0}
                      max={23}
                      value={settingsForm.scheduleStartHour}
                      onChange={(e) =>
                        persistSettingsPatch({
                          scheduleStartHour: Number(e.target.value),
                        })
                      }
                    />
                  </label>
                  <label className="redflow-label">
                    可发结束（时）
                    <input
                      className="redflow-input"
                      type="number"
                      min={0}
                      max={23}
                      value={settingsForm.scheduleEndHour}
                      onChange={(e) =>
                        persistSettingsPatch({
                          scheduleEndHour: Number(e.target.value),
                        })
                      }
                    />
                  </label>
                </div>
                <div className="redflow-settings-row">
                  <label className="redflow-label">
                    最早间隔（小时）
                    <input
                      className="redflow-input"
                      type="number"
                      min={1}
                      max={48}
                      value={settingsForm.scheduleMinLeadHours}
                      onChange={(e) =>
                        persistSettingsPatch({
                          scheduleMinLeadHours: Number(e.target.value),
                        })
                      }
                    />
                  </label>
                  <label className="redflow-label">
                    最多提前（天）
                    <input
                      className="redflow-input"
                      type="number"
                      min={1}
                      max={14}
                      value={settingsForm.scheduleMaxAheadDays}
                      onChange={(e) =>
                        persistSettingsPatch({
                          scheduleMaxAheadDays: Number(e.target.value),
                        })
                      }
                    />
                  </label>
                </div>
              </div>
            ) : (
              <p className="redflow-settings-hint">
                页面上不会勾选「定时发布」，只把笔记存成创作者草稿。
              </p>
            )}

            <label className="redflow-toggle redflow-toggle-block">
              <input
                type="checkbox"
                checked={settingsForm.declareAiContent !== false}
                onChange={(e) =>
                  persistSettingsPatch({ declareAiContent: e.target.checked })
                }
              />
              <span>声明「笔记含AI合成内容」</span>
            </label>
            <p className="redflow-settings-hint">
              默认开启。导入时会点「添加内容类型声明」→「笔记含AI合成内容」。
            </p>
          </section>

          <section className="redflow-settings-section">
            <h3 className="redflow-settings-title">发布内容</h3>
            <p className="redflow-settings-hint">
              合集按名字匹配；群聊名为空则点第一项；引用笔记默认点「我的笔记」第一项。
            </p>

            <label className="redflow-label">
              合集名称
              <input
                className="redflow-input"
                placeholder={DEFAULT_COLLECTION_NAME}
                value={settingsForm.collectionName}
                onChange={(e) =>
                  persistSettingsPatch({ collectionName: e.target.value })
                }
              />
            </label>

            <label className="redflow-label">
              必选话题（逗号分隔）
              <input
                className="redflow-input"
                placeholder={DEFAULT_REQUIRED_TOPICS}
                value={settingsForm.requiredTopics}
                onChange={(e) =>
                  persistSettingsPatch({ requiredTopics: e.target.value })
                }
              />
            </label>
            <p className="redflow-settings-hint">
              正文末尾会写成 #话题，并与草稿 keywords 合并。默认含 #AI作图提示词。
            </p>

            <label className="redflow-label">
              正文模板
              <textarea
                className="redflow-input redflow-textarea"
                rows={5}
                spellCheck={false}
                placeholder={DEFAULT_BODY_TEMPLATE}
                value={settingsForm.bodyTemplate}
                onChange={(e) =>
                  persistSettingsPatch({ bodyTemplate: e.target.value })
                }
              />
            </label>
            <p className="redflow-settings-hint">
              占位符：{"{keywords}"}、{"{replyKeyword}"}、{"{topics}"}。空则恢复默认。
            </p>

            <label className="redflow-toggle redflow-toggle-block">
              <input
                type="checkbox"
                checked={settingsForm.groupChatEnabled === true}
                onChange={(e) =>
                  persistSettingsPatch({ groupChatEnabled: e.target.checked })
                }
              />
              <span>选择群聊</span>
            </label>
            {settingsForm.groupChatEnabled === true ? (
              <label className="redflow-label">
                群聊名称（空=第一项）
                <input
                  className="redflow-input"
                  placeholder="留空则选列表第一项"
                  value={settingsForm.groupChatName}
                  onChange={(e) =>
                    persistSettingsPatch({ groupChatName: e.target.value })
                  }
                />
              </label>
            ) : null}

            <label className="redflow-toggle redflow-toggle-block">
              <input
                type="checkbox"
                checked={settingsForm.quoteNoteEnabled === true}
                onChange={(e) =>
                  persistSettingsPatch({ quoteNoteEnabled: e.target.checked })
                }
              />
              <span>引用笔记（点第一项）</span>
            </label>
          </section>

          <section className="redflow-settings-section">
            <h3 className="redflow-settings-title">自动化</h3>
            <label className="redflow-toggle">
              <input
                type="checkbox"
                checked={Boolean(settingsForm.dailyAutoPublish)}
                onChange={(e) => {
                  const on = e.target.checked;
                  const next = normalizeConfig({
                    ...settingsForm,
                    dailyAutoPublish: on,
                  });
                  setSettingsForm(next);
                  skipConfigReloadRef.current = true;
                  void saveConfig(next).then(() => {
                    setConfig(next);
                    const n = next.dailyAutoCount;
                    setSettingsMsg(
                      on
                        ? `已开启每天自动 ${n} 篇：侧栏开着且发布页打开时自动跑`
                        : "已关闭每天自动发布",
                    );
                  });
                }}
              />
              <span>每天自动处理</span>
            </label>
            <div className="redflow-settings-row">
              <label className="redflow-label">
                每天篇数
                <input
                  className="redflow-input"
                  type="number"
                  min={1}
                  max={50}
                  value={settingsForm.dailyAutoCount}
                  onChange={(e) =>
                    persistSettingsPatch({
                      dailyAutoCount: Number(e.target.value),
                    })
                  }
                />
              </label>
            </div>
            <p className="redflow-settings-hint">
              与「开始自动化」、手动导入同一套逻辑；侧栏与发布页需保持打开。待处理不足设定篇数时当天不跑。
            </p>

            <label className="redflow-toggle redflow-toggle-block">
              <input
                type="checkbox"
                checked={Boolean(settingsForm.compactPublishWindow)}
                onChange={(e) => {
                  const on = e.target.checked;
                  persistSettingsPatch({ compactPublishWindow: on });
                  if (on) {
                    void applyCompactPublishWindowNow().then((res) => {
                      setSettingsMsg(
                        res.ok
                          ? "已把发布页收到右侧小窗（约 800×620），不挡主屏幕"
                          : `小窗未能打开：${res.error}`,
                      );
                    });
                  } else {
                    setSettingsMsg("已关闭独立小窗；下次仍在当前浏览器窗口打开发布页");
                  }
                }}
              />
              <span>发布页独立小窗（右侧收窄）</span>
            </label>
            <p className="redflow-settings-hint">
              勾选后把小红书创作页拆成单独窗口，贴在屏幕右边，比参考截图再略小。窗口不要最小化，自动化才能点到页面。
            </p>
          </section>

          <section className="redflow-settings-section">
            <div className="redflow-settings-title-row">
              <h3 className="redflow-settings-title">停顿节奏</h3>
              <div className="redflow-pace-presets">
                {PACE_PRESETS.map((preset) => (
                  <button
                    key={preset.id}
                    type="button"
                    className="redflow-pace-preset"
                    onClick={() => applyPacePreset(preset.pace)}
                  >
                    {preset.label}
                  </button>
                ))}
              </div>
            </div>
            <p className="redflow-settings-hint">
              各步骤等待毫秒数（50–20000）。网络快、页面稳时可试「快速」；填表偶发失败可试「稳健」或调大「填表步骤」。
            </p>
            <div className="redflow-pace-grid">
              {PACE_FIELDS.map(({ key, label, hint }) => (
                <label key={key} className="redflow-pace-field">
                  <span className="redflow-pace-label">
                    {label}
                    {hint ? (
                      <span className="redflow-pace-hint">{hint}</span>
                    ) : null}
                  </span>
                  <div className="redflow-pace-input-wrap">
                    <input
                      className="redflow-input redflow-input-pace"
                      type="number"
                      min={50}
                      max={20000}
                      step={1}
                      value={settingsForm.pace?.[key] ?? DEFAULT_PACE_MS[key]}
                      onChange={(e) => persistPaceField(key, e.target.value)}
                    />
                    <span className="redflow-pace-unit">ms</span>
                  </div>
                </label>
              ))}
            </div>
          </section>

          {settingsMsg && <p className="redflow-settings-msg">{settingsMsg}</p>}

          <div className="redflow-settings-actions">
            <button type="submit" className="redflow-btn" disabled={saving}>
              {saving ? "保存中…" : "保存配置"}
            </button>
            <button
              type="button"
              className="redflow-btn redflow-btn-ghost"
              disabled={
                saving ||
                settingsSyncing ||
                syncing ||
                Boolean(status?.syncing) ||
                !isConfigReady(settingsForm)
              }
              onClick={() => void onSyncFromSettings()}
            >
              {settingsSyncing || syncing || status?.syncing
                ? "同步中…"
                : "同步草稿"}
            </button>
            {dangerConfirm ? (
              <div className="redflow-wipe-confirm">
                <p>
                  只清空本机草稿列表，然后重新同步索引。已传 id
                  永久保留，不会被清掉；令牌、仓库和路径配置也不动。
                </p>
                <div className="redflow-wipe-actions">
                  <button
                    type="button"
                    className="redflow-btn redflow-btn-ghost"
                    onClick={() => {
                      if (wipeTimerRef.current) {
                        window.clearTimeout(wipeTimerRef.current);
                      }
                      setDangerConfirm(false);
                    }}
                  >
                    取消
                  </button>
                  <button
                    type="button"
                    className="redflow-btn redflow-btn-danger"
                    onClick={() => void onConfirmWipeAll()}
                  >
                    确认清空列表
                  </button>
                </div>
              </div>
            ) : (
              <section className="redflow-settings-section redflow-settings-section-danger">
                <h3 className="redflow-settings-title">数据清理</h3>
                <p className="redflow-settings-hint">
                  已传 id 用于防重复，界面上无法清空。
                </p>
                <div className="redflow-danger-row redflow-danger-row-single">
                  <button
                    type="button"
                    className="redflow-btn-soft"
                    onClick={askWipeDrafts}
                  >
                    清空草稿列表
                  </button>
                </div>
              </section>
            )}
          </div>
        </form>
      )}

      {preview && (
        <div
          className="redflow-lightbox"
          role="dialog"
          aria-label="查看配图"
          aria-modal="true"
          onClick={closePreview}
        >
          <div
            className="redflow-lightbox-inner"
            onClick={(e) => e.stopPropagation()}
          >
            <header className="redflow-lightbox-head">
              <span className="redflow-lightbox-title" title={preview.title}>
                {preview.title}
              </span>
              <span className="redflow-lightbox-count">
                {preview.index + 1}/{preview.urls.length}
              </span>
              <button type="button" onClick={closePreview} title="关闭">
                ×
              </button>
            </header>
            <div className="redflow-lightbox-stage">
              {preview.urls.length > 1 && (
                <button
                  type="button"
                  className="redflow-lightbox-nav is-prev"
                  onClick={() => stepPreview(-1)}
                  title="上一张"
                  aria-label="上一张"
                >
                  ‹
                </button>
              )}
              <img
                className="redflow-lightbox-img"
                src={preview.urls[preview.index]}
                alt=""
              />
              {preview.urls.length > 1 && (
                <button
                  type="button"
                  className="redflow-lightbox-nav is-next"
                  onClick={() => stepPreview(1)}
                  title="下一张"
                  aria-label="下一张"
                >
                  ›
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {sourceDeleteConfirm && (
        <div
          className="redflow-confirm-overlay"
          role="dialog"
          aria-modal="true"
          aria-labelledby="redflow-source-delete-title"
          onClick={() => setSourceDeleteConfirm(null)}
        >
          <div
            className="redflow-confirm-card"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="redflow-confirm-icon" aria-hidden>
              !
            </div>
            <h3 id="redflow-source-delete-title" className="redflow-confirm-title">
              删除数据源？
            </h3>
            <p className="redflow-confirm-body">
              即将移除「
              <strong>
                {sourceDeleteConfirm.name ||
                  formatRepoSlug(
                    sourceDeleteConfirm.owner,
                    sourceDeleteConfirm.repo,
                  )}
              </strong>
              」（
              {formatRepoSlug(
                sourceDeleteConfirm.owner,
                sourceDeleteConfirm.repo,
              )}
              ）。本地该源草稿缓存不会自动清掉；点保存后配置才写入。
            </p>
            <div className="redflow-confirm-actions">
              <button
                type="button"
                className="redflow-btn redflow-btn-ghost"
                onClick={() => setSourceDeleteConfirm(null)}
              >
                取消
              </button>
              <button
                type="button"
                className="redflow-btn redflow-btn-danger"
                onClick={() => {
                  const removing = sourceDeleteConfirm;
                  setSourceDeleteConfirm(null);
                  if (!removing) return;
                  if (settingsForm.sources.length <= 1) return;
                  const rest = settingsForm.sources.filter(
                    (s) => s.id !== removing.id,
                  );
                  if (!rest.length) return;
                  const next = normalizeConfig({
                    ...settingsForm,
                    sources: rest,
                    activeSourceId:
                      settingsForm.activeSourceId === removing.id
                        ? rest[0]!.id
                        : settingsForm.activeSourceId,
                  });
                  setSettingsForm(next);
                  const src = getActiveSource(next);
                  setSettingsRepoSlug(
                    src ? formatRepoSlug(src.owner, src.repo) : "",
                  );
                  setSettingsMsg(
                    `已从列表移除「${removing.name || formatRepoSlug(removing.owner, removing.repo)}」，请点保存生效`,
                  );
                }}
              >
                确认删除
              </button>
            </div>
          </div>
        </div>
      )}

      {toast && <div className="redflow-toast">{toast}</div>}
    </aside>
  );
}
