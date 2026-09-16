import { useCallback, useEffect, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import {
  DEFAULT_CONFIG,
  DEFAULT_DRAFTS_FILE,
  DEFAULT_IMAGES_PATH,
  DEFAULT_PROMPTS_PATH,
  formatRepoSlug,
  parseRepoSlug,
  type ExtensionConfig,
} from "@/types";
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
import { getCategoryList } from "@/lib/github";
import {
  sendRedFlow,
  type CachedItemDTO,
  type SyncStatusDTO,
} from "@/lib/messages";
import {
  clearUploadHistory,
  getConfig,
  getDailyAutoDate,
  localDateKey,
  normalizeConfig,
  saveConfig,
  setDailyAutoDate,
} from "@/lib/storage";
import { hasGitHubAccess, requestGitHubAccess } from "@/lib/permissions";
import { hasPublishTabOpen } from "@/lib/page-bridge";
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
  return Boolean(cfg.owner.trim() && cfg.repo.trim());
}

/** 草稿 id 时间戳小字展示：2026-01-02T11-23-14-833Z-xxx → 2026-01-02 11:23 */
/** 草稿 id 时间戳小字展示：2026-01-02T11-23-14-833Z-xxx → 2026-01-02 11:23 */
function formatDraftTime(fileId: string): string {
  const m = fileId.match(
    /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})(?:-(\d+))?Z?/i,
  );
  if (m) return `${m[1]} ${m[2]}:${m[3]}`;
  return fileId.length > 22 ? `${fileId.slice(0, 20)}…` : fileId;
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
  } | null>(null);
  const [banner, setBanner] = useState<{
    type: "error" | "info";
    text: string;
  } | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [dangerConfirm, setDangerConfirm] = useState<null | "flags" | "drafts">(
    null,
  );
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
  categoryRef.current = category;
  itemsRef.current = items;
  busyRef.current = busyId;
  autoRunningRef.current = autoRunning;

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
    };
  }, []);

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
      const mapped: PanelItem[] = res.items
        .map((it) => ({
          ...it,
          uploaded: Boolean(it.uploaded),
          uploadedAt: it.uploadedAt ?? null,
        }))
        .sort((a, b) => Number(a.uploaded) - Number(b.uploaded));
      setItems(mapped);

      // 空列表且后台真实在 sync：有限次轮询；分类切换后作废
      if (
        !mapped.length &&
        res.status.syncing &&
        emptyPollRef.current < 8 &&
        categoryRef.current === cat
      ) {
        emptyPollRef.current += 1;
        window.setTimeout(() => {
          if (categoryRef.current === cat && loadGenRef.current === gen) {
            void loadFromLocal(cat);
          }
        }, 1500);
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

  const applyConfig = useCallback(
    async (cfg: ExtensionConfig, preferCat?: string) => {
      setConfig(cfg);
      setSettingsForm(cfg);
      setSettingsRepoSlug(formatRepoSlug(cfg.owner, cfg.repo));
      const cats = getCategoryList(cfg);
      const nextCat =
        preferCat && cats.includes(preferCat) ? preferCat : (cats[0] ?? "");
      setCategory(nextCat);
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
      } else {
        if ("status" in res) setStatus(res.status);
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
        setItems((prev) =>
          prev.map((x) =>
            x.fileId === item.fileId && x.category === item.category
              ? { ...x, uploaded: true, uploadedAt, hasImage: true }
              : x,
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
    setAutoProgress({
      current: 0,
      total: queue.length,
      batchNo: 1,
      batchCount: Math.max(1, queue.length / AUTO_BATCH_SIZE),
      batchIndex: 0,
      batchSize: AUTO_BATCH_SIZE,
      title: mode === "daily" ? "每日自动排队中" : "排队中",
      fileId: "",
    });
    showToast(
      mode === "daily"
        ? `每日自动：开始今天的 ${AUTO_BATCH_SIZE} 篇`
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
          setItems((prev) =>
            prev.map((x) =>
              x.fileId === item.fileId && x.category === item.category
                ? { ...x, uploaded: true, uploadedAt, hasImage: true }
                : x,
            ),
          );
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
    const pending = pickOldestPending(toUploadInputs(items));
    if (!pending.length) {
      showToast("没有未暂存的草稿");
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
      setPreview({ title: item.title, urls });
    } catch (e) {
      showError(e instanceof Error ? e.message : String(e));
    }
  };

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

  const onSettingsChange =
    (key: keyof ExtensionConfig) =>
    (e: ChangeEvent<HTMLInputElement>) => {
      setSettingsForm((prev) => ({ ...prev, [key]: e.target.value }));
      setSettingsMsg(null);
    };

  const onSaveSettings = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setSettingsMsg(null);
    try {
      const parsed = parseRepoSlug(settingsRepoSlug);
      if (!parsed) {
        setSettingsMsg("仓库请填写为 owner/repo");
        return;
      }

      const next: ExtensionConfig = {
        githubToken: settingsForm.githubToken.trim(),
        owner: parsed.owner,
        repo: parsed.repo,
        branch: settingsForm.branch.trim() || "master",
        basePath:
          settingsForm.basePath.trim().replace(/^\/+|\/+$/g, "") ||
          DEFAULT_DRAFTS_FILE,
        imagesPath:
          settingsForm.imagesPath.trim().replace(/^\/+|\/+$/g, "") ||
          DEFAULT_IMAGES_PATH,
        categories: settingsForm.categories.trim(),
        dailyAutoPublish: Boolean(settingsForm.dailyAutoPublish),
        submitMode:
          settingsForm.submitMode === "schedule" ? "schedule" : "draft",
        scheduleStartHour: settingsForm.scheduleStartHour,
        scheduleEndHour: settingsForm.scheduleEndHour,
        scheduleMinLeadHours: settingsForm.scheduleMinLeadHours,
        scheduleMaxAheadDays: settingsForm.scheduleMaxAheadDays,
        pace: normalizePace(settingsForm.pace),
      };

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

      setSettingsMsg("已保存，正在同步草稿索引…");
      setTab("main");
      const syncRes = await sendRedFlow({
        type: "SYNC_NOW",
        reason: "settings-save",
      });
      if (!syncRes.ok) {
        setSettingsMsg(`已保存，同步失败：${syncRes.error}`);
        showError(syncRes.error);
      } else {
        if ("status" in syncRes) setStatus(syncRes.status);
        const r = "result" in syncRes ? syncRes.result : undefined;
        setSettingsMsg(
          r
            ? `已保存并同步草稿 ${r.fetchedJson} 条`
            : "配置已保存，本地缓存已更新",
        );
        showToast(
          r ? `已同步草稿 ${r.fetchedJson} 条` : "配置已保存并同步",
        );
        const cats = getCategoryList(next);
        if (cats[0]) await loadFromLocal(cats[0]);
      }
    } finally {
      setSaving(false);
    }
  };

  const askDanger = (kind: "flags" | "drafts") => {
    setDangerConfirm(kind);
    if (wipeTimerRef.current) window.clearTimeout(wipeTimerRef.current);
    wipeTimerRef.current = window.setTimeout(() => setDangerConfirm(null), 8000);
  };

  const onClearHistory = async () => {
    if (wipeTimerRef.current) window.clearTimeout(wipeTimerRef.current);
    setDangerConfirm(null);
    await sendRedFlow({ type: "CLEAR_UPLOADED" });
    await clearUploadHistory();
    setSettingsMsg("已清空发布标记（草稿内容仍保留）");
    showToast("已清空发布标记");
    if (category) await loadFromLocal(category);
  };

  const onAskWipeAll = () => askDanger("drafts");

  const onConfirmWipeAll = async () => {
    if (wipeTimerRef.current) window.clearTimeout(wipeTimerRef.current);
    setDangerConfirm(null);
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
      showToast("草稿列表已清空，保留令牌和仓库配置");
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
            ? `草稿列表已重建，同步 ${r.fetchedJson} 条`
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
    let cancelled = false;
    const tick = async () => {
      if (cancelled || dailyKickRef.current) return;
      if (autoRunningRef.current || busyRef.current || autoUploadQueue.isRunning) {
        return;
      }
      const last = await getDailyAutoDate();
      if (last === localDateKey()) return;
      if (!(await hasPublishTabOpen())) return;
      const pending = pickOldestPending(toUploadInputs(itemsRef.current));
      const queue = takeDailyBatch(pending, AUTO_BATCH_SIZE);
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
  }, [config.dailyAutoPublish]);

  const showSyncChrome = syncing || Boolean(status?.syncing);

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
            <span className="redflow-label">微信图文草稿</span>
            <span className="redflow-muted">
              {items.length
                ? `${items.length} 条 · 未传 ${items.filter((i) => !i.uploaded).length} · 已传 ${items.filter((i) => i.uploaded).length}`
                : "同步后显示"}
              {autoProgress
                ? ` · 自动 ${autoProgress.current}/${autoProgress.total}`
                : ""}
            </span>
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
            {items.map((item) => (
              <article
                key={`${item.category}::${item.fileId}`}
                className={`redflow-card ${item.uploaded ? "is-synced" : ""}`}
              >
                <h3 className="redflow-card-title" title={item.title}>
                  {item.title}
                </h3>
                {item.keywords?.length ? (
                  <div className="redflow-keywords" title={item.keywords.join(" · ")}>
                    {item.keywords.map((kw) => (
                      <span key={kw} className="redflow-kw">
                        {kw}
                      </span>
                    ))}
                  </div>
                ) : (
                  <p className="redflow-keywords-empty">无关键词</p>
                )}
                <div className="redflow-card-foot">
                  <time className="redflow-time" title={item.fileId}>
                    {formatDraftTime(item.fileId)}
                  </time>
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
                        busyId != null || showSyncChrome || autoRunning
                      }
                      onClick={() => void onImport(item)}
                    >
                      {busyId === item.fileId ? "处理中…" : "导入"}
                    </button>
                  )}
                </div>
              </article>
            ))}
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
              同步只拉草稿索引；导入时再读{" "}
              <code>{DEFAULT_PROMPTS_PATH}/&#123;id&#125;.json</code> 与配图目录。
            </p>

            <label className="redflow-label">
              GitHub 令牌
              <input
                className="redflow-input"
                type="password"
                autoComplete="off"
                placeholder="私有仓必填 ghp_..."
                value={settingsForm.githubToken}
                onChange={onSettingsChange("githubToken")}
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

            <div className="redflow-settings-row">
              <label className="redflow-label">
                分支
                <input
                  className="redflow-input"
                  placeholder="master"
                  value={settingsForm.branch}
                  onChange={onSettingsChange("branch")}
                />
              </label>
              <label className="redflow-label">
                草稿索引文件
                <input
                  className="redflow-input"
                  placeholder={DEFAULT_DRAFTS_FILE}
                  value={settingsForm.basePath}
                  onChange={onSettingsChange("basePath")}
                />
              </label>
            </div>

            <label className="redflow-label">
              图片目录
              <input
                className="redflow-input"
                placeholder={DEFAULT_IMAGES_PATH}
                value={settingsForm.imagesPath}
                onChange={onSettingsChange("imagesPath")}
              />
            </label>

            <p className="redflow-perm-line">
              GitHub 权限：{githubOk ? "已授予" : "未授予"}
              {status?.itemCount != null ? ` · 本地 ${status.itemCount} 条` : ""}
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
                    setSettingsMsg(
                      on
                        ? "已开启每天自动 5 篇：侧栏开着且发布页打开时自动跑"
                        : "已关闭每天自动发布",
                    );
                  });
                }}
              />
              <span>每天自动处理 5 篇</span>
            </label>
            <p className="redflow-settings-hint">
              与「开始自动化」、手动导入同一套逻辑；侧栏与发布页需保持打开。
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
                      step={50}
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
              {saving ? "保存中…" : "保存并同步草稿"}
            </button>
            {dangerConfirm ? (
              <div className="redflow-wipe-confirm">
                <p>
                  {dangerConfirm === "flags"
                    ? "只去掉已导入 / 已发布标记，草稿和配图都还在。"
                    : "只清空本机草稿列表和发布记录，然后重新同步索引。令牌、仓库和路径配置不动。"}
                </p>
                <div className="redflow-wipe-actions">
                  <button
                    type="button"
                    className="redflow-btn redflow-btn-ghost"
                    onClick={() => {
                      if (wipeTimerRef.current) {
                        window.clearTimeout(wipeTimerRef.current);
                      }
                      setDangerConfirm(null);
                    }}
                  >
                    取消
                  </button>
                  <button
                    type="button"
                    className="redflow-btn redflow-btn-danger"
                    onClick={() =>
                      void (dangerConfirm === "flags"
                        ? onClearHistory()
                        : onConfirmWipeAll())
                    }
                  >
                    {dangerConfirm === "flags" ? "确认清空标记" : "确认清空列表"}
                  </button>
                </div>
              </div>
            ) : (
              <section className="redflow-settings-section redflow-settings-section-danger">
                <h3 className="redflow-settings-title">数据清理</h3>
                <div className="redflow-danger-row">
                  <button
                    type="button"
                    className="redflow-btn-soft"
                    onClick={() => askDanger("flags")}
                  >
                    清空发布标记
                  </button>
                  <button
                    type="button"
                    className="redflow-btn-soft"
                    onClick={onAskWipeAll}
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
          onClick={closePreview}
        >
          <div
            className="redflow-lightbox-inner"
            onClick={(e) => e.stopPropagation()}
          >
            <header className="redflow-lightbox-head">
              <span>{preview.title}</span>
              <button type="button" onClick={closePreview} title="关闭">
                ×
              </button>
            </header>
            <div className="redflow-lightbox-imgs">
              {preview.urls.map((u) => (
                <img key={u} src={u} alt="" />
              ))}
            </div>
          </div>
        </div>
      )}

      {toast && <div className="redflow-toast">{toast}</div>}
    </aside>
  );
}
