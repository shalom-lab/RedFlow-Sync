import { useCallback, useEffect, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { DEFAULT_CONFIG, type ExtensionConfig } from "@/types";
import { fillPublishForm, waitForPublishForm } from "@/lib/dom-inject";
import { getCategoryList } from "@/lib/github";
import {
  sendRedFlow,
  type CachedItemDTO,
  type SyncStatusDTO,
} from "@/lib/messages";
import {
  clearUploadHistory,
  getConfig,
  getUploadHistory,
  isUploaded,
  markUploaded,
  saveConfig,
} from "@/lib/storage";
import { hasGitHubAccess } from "@/lib/permissions";

type TabId = "main" | "settings";

interface PanelItem extends CachedItemDTO {
  uploaded: boolean;
  uploadedAt?: string;
}

function isConfigReady(cfg: ExtensionConfig): boolean {
  return Boolean(cfg.owner.trim() && cfg.repo.trim() && cfg.categories.trim());
}

function LocalThumb({
  category,
  fileId,
  hasImage,
  hasThumb,
}: {
  category: string;
  fileId: string;
  hasImage: boolean;
  hasThumb: boolean;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [loadingThumb, setLoadingThumb] = useState(false);

  useEffect(() => {
    if (!hasImage && !hasThumb) return;
    let alive = true;
    let objectUrl: string | null = null;
    setUrl(null);
    setLoadingThumb(true);

    void sendRedFlow({
      type: "GET_IMAGE",
      category,
      fileId,
      variant: "thumb",
    })
      .then((res) => {
        if (!alive) return;
        setLoadingThumb(false);
        if (!res.ok || !("blob" in res)) return;
        const blob = new Blob([res.blob], { type: res.mime });
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      })
      .catch(() => {
        if (!alive) return;
        setLoadingThumb(false);
      });

    return () => {
      alive = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [category, fileId, hasImage, hasThumb]);

  return (
    <div
      className={`redflow-thumb-inner ${loadingThumb && !url ? "is-loading" : ""}`}
    >
      {url ? (
        <img
          className="redflow-thumb"
          src={url}
          alt={fileId}
          loading="lazy"
          onError={(e) => {
            (e.target as HTMLImageElement).style.opacity = "0.3";
          }}
        />
      ) : null}
    </div>
  );
}

export function PanelApp() {
  const [collapsed, setCollapsed] = useState(false);
  const [tab, setTab] = useState<TabId>("main");
  const [config, setConfig] = useState<ExtensionConfig>(DEFAULT_CONFIG);
  const [settingsForm, setSettingsForm] =
    useState<ExtensionConfig>(DEFAULT_CONFIG);
  const [categories, setCategories] = useState<string[]>([]);
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
  const [toast, setToast] = useState<string | null>(null);
  const emptyPollRef = useRef(0);
  const toastTimerRef = useRef<number | null>(null);
  const loadGenRef = useRef(0);
  const categoryRef = useRef(category);
  const skipConfigReloadRef = useRef(false);
  categoryRef.current = category;

  const showToast = (msg: string) => {
    setToast(msg);
    if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
    toastTimerRef.current = window.setTimeout(() => setToast(null), 3200);
  };

  useEffect(() => {
    return () => {
      if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
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
      const history = await getUploadHistory();
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
        .map((it) => {
          const u = isUploaded(history, it.category, it.fileId);
          return {
            ...it,
            uploaded: u.uploaded,
            uploadedAt: u.uploadedAt,
          };
        })
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
      const cats = getCategoryList(cfg);
      setCategories(cats);
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

  const onCategoryChange = async (cat: string) => {
    emptyPollRef.current = 0;
    setCategory(cat);
    await loadFromLocal(cat);
  };

  const onRefresh = async () => {
    if (!isConfigReady(config)) {
      setTab("settings");
      showToast("请先在 Settings 填写仓库配置");
      return;
    }
    if (!(await hasGitHubAccess())) {
      setGithubOk(false);
      showToast("请先到扩展 Options 页授权 GitHub 访问");
      chrome.runtime.openOptionsPage();
      return;
    }
    setGithubOk(true);
    setSyncing(true);
    setError(null);
    try {
      const res = await sendRedFlow({
        type: "SYNC_NOW",
        reason: "panel-refresh",
      });
      if (!res.ok) {
        setError(res.error);
        showToast(res.error);
      } else {
        if ("status" in res) setStatus(res.status);
        const r = "result" in res ? res.result : undefined;
        showToast(
          r
            ? `同步完成：新JSON ${r.fetchedJson} / 新图 ${r.fetchedImages} / 跳过 ${r.skipped}`
            : "同步完成",
        );
      }
      if (category) await loadFromLocal(category);
    } finally {
      setSyncing(false);
    }
  };

  const onImport = async (item: PanelItem) => {
    if (busyId != null) return;
    setBusyId(item.fileId);
    try {
      const ready = await waitForPublishForm(8000);
      if (!ready) {
        showToast("发布表单尚未就绪，请稍后再试");
        return;
      }

      let imageBlob: Blob | undefined;
      const imgRes = await sendRedFlow({
        type: "GET_IMAGE",
        category: item.category,
        fileId: item.fileId,
        variant: "full",
      });
      if (imgRes.ok && "blob" in imgRes) {
        imageBlob = new Blob([imgRes.blob], { type: imgRes.mime });
      } else if (item.imageRawUrl) {
        // Content Script 不能直连 GitHub（CORS）；经 Background 拉取
        const remote = await sendRedFlow({
          type: "FETCH_REMOTE_IMAGE",
          url: item.imageRawUrl,
        });
        if (remote.ok && "blob" in remote) {
          imageBlob = new Blob([remote.blob], { type: remote.mime });
        }
      }

      if (!imageBlob) {
        showToast("无本地图片，请先点「同步仓库」");
        return;
      }

      const result = await fillPublishForm({
        fileId: item.fileId,
        title: item.title,
        body: item.body,
        imageBlob,
      });

      if (result.ok) {
        await markUploaded(item.category, item.fileId);
        setItems((prev) =>
          prev.map((x) =>
            x.fileId === item.fileId && x.category === item.category
              ? { ...x, uploaded: true, uploadedAt: new Date().toISOString() }
              : x,
          ),
        );
        showToast(`已填入 ${item.fileId}`);
      } else {
        showToast(`填入失败：${result.error ?? "未知错误"}`);
      }
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
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
      const next: ExtensionConfig = {
        githubToken: settingsForm.githubToken.trim(),
        owner: settingsForm.owner.trim(),
        repo: settingsForm.repo.trim(),
        branch: settingsForm.branch.trim() || "main",
        basePath: settingsForm.basePath.trim().replace(/^\/+|\/+$/g, ""),
        categories: settingsForm.categories.trim(),
      };

      if (!next.owner || !next.repo) {
        setSettingsMsg("Owner 与 Repo 必填");
        return;
      }
      if (!next.categories) {
        setSettingsMsg("请至少填写一个 category");
        return;
      }

      skipConfigReloadRef.current = true;
      await saveConfig(next);
      await applyConfig(next);

      const granted = await hasGitHubAccess();
      setGithubOk(granted);
      if (!granted) {
        setSettingsMsg(
          "配置已保存。请打开扩展 Options 页完成 GitHub 授权后再同步（Content Script 无法弹出授权窗）。",
        );
        showToast("需在 Options 页授权 GitHub");
        return;
      }

      setSettingsMsg("已保存，正在同步…");
      setTab("main");
      const syncRes = await sendRedFlow({
        type: "SYNC_NOW",
        reason: "settings-save",
      });
      if (!syncRes.ok) {
        setSettingsMsg(`已保存，同步失败：${syncRes.error}`);
        showToast(syncRes.error);
      } else {
        if ("status" in syncRes) setStatus(syncRes.status);
        setSettingsMsg("配置已保存，本地缓存已更新");
        showToast("配置已保存并同步");
        const cats = getCategoryList(next);
        if (cats[0]) await loadFromLocal(cats[0]);
      }
    } finally {
      setSaving(false);
    }
  };

  const onClearHistory = async () => {
    await clearUploadHistory();
    setSettingsMsg("已清空发布标记（内容缓存保留）");
    if (category) await loadFromLocal(category);
  };

  if (collapsed) {
    return (
      <button
        type="button"
        className="redflow-fab"
        onClick={() => setCollapsed(false)}
        title="展开 RedFlow-Sync"
      >
        RF
      </button>
    );
  }

  const syncLabel = status?.lastSyncAt
    ? `缓存 ${new Date(status.lastSyncAt).toLocaleString()}`
    : "尚未同步到本地";
  const showSyncChrome = syncing || Boolean(status?.syncing);

  return (
    <aside
      className={`redflow-panel ${showSyncChrome ? "is-syncing" : ""}`}
      aria-label="RedFlow-Sync"
    >
      {showSyncChrome && <div className="redflow-sync-bar" aria-hidden />}

      <header className="redflow-header">
        <div className="redflow-brand">
          <span className={`redflow-logo ${showSyncChrome ? "is-spin" : ""}`}>
            RF
          </span>
          <div>
            <strong>RedFlow-Sync</strong>
            <p>
              {showSyncChrome ? (
                <span className="redflow-sync-text">
                  正在从 GitHub 增量同步
                  <span className="redflow-dots" aria-hidden>
                    <i />
                    <i />
                    <i />
                  </span>
                </span>
              ) : (
                syncLabel
              )}
            </p>
          </div>
        </div>
        <button
          type="button"
          className="redflow-icon-btn"
          onClick={() => setCollapsed(true)}
          title="收起"
        >
          ×
        </button>
      </header>

      {showSyncChrome && tab === "main" && (
        <div className="redflow-sync-banner" role="status">
          <span className="redflow-spinner" aria-hidden />
          <div>
            <strong>同步进行中</strong>
            <p>仅拉取有变更的 JSON / 图片到本地缓存</p>
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
          className={`redflow-tab ${tab === "settings" ? "is-active" : ""}`}
          onClick={() => setTab("settings")}
        >
          Settings
        </button>
      </nav>

      {tab === "main" ? (
        <>
          <div className="redflow-toolbar">
            <label className="redflow-label" htmlFor="rf-cat">
              分类
            </label>
            <select
              id="rf-cat"
              className="redflow-select"
              value={category}
              onChange={(e) => void onCategoryChange(e.target.value)}
              disabled={!categories.length || showSyncChrome}
            >
              {!categories.length && (
                <option value="">请先到 Settings 配置</option>
              )}
              {categories.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </div>

          <div className="redflow-list">
            {!isConfigReady(config) && (
              <div className="redflow-empty">
                尚未配置数据源
                <button
                  type="button"
                  className="redflow-link-btn"
                  onClick={() => setTab("settings")}
                >
                  去 Settings 填写
                </button>
              </div>
            )}
            {isConfigReady(config) && showSyncChrome && !items.length && (
              <div className="redflow-empty redflow-empty-sync">
                <span className="redflow-spinner redflow-spinner-lg" aria-hidden />
                <p>正在拉取仓库数据到本地…</p>
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
                  本地暂无数据，点底部「同步」拉取仓库内容
                </div>
              )}
            {items.map((item) => (
              <article
                key={`${item.category}::${item.fileId}`}
                className={`redflow-card ${item.uploaded ? "is-synced" : ""}`}
              >
                <div className="redflow-thumb-wrap">
                  <LocalThumb
                    category={item.category}
                    fileId={item.fileId}
                    hasImage={item.hasImage}
                    hasThumb={item.hasThumb}
                  />
                </div>
                <div className="redflow-card-body">
                  <h3 title={item.title}>{item.title}</h3>
                  <p>{item.body || "（无正文）"}</p>
                  <div className="redflow-card-actions">
                    {item.uploaded ? (
                      <span className="redflow-badge">已同步</span>
                    ) : (
                      <button
                        type="button"
                        className="redflow-btn"
                        disabled={busyId != null || showSyncChrome}
                        onClick={() => void onImport(item)}
                      >
                        {busyId === item.fileId ? "填入中…" : "导入"}
                      </button>
                    )}
                  </div>
                </div>
              </article>
            ))}
          </div>

          <footer className="redflow-footer">
            <button
              type="button"
              className="redflow-btn"
              disabled={showSyncChrome || !isConfigReady(config)}
              onClick={() => void onRefresh()}
            >
              {showSyncChrome ? (
                <>
                  <span className="redflow-spinner redflow-spinner-btn" aria-hidden />
                  同步中…
                </>
              ) : (
                "同步仓库"
              )}
            </button>
          </footer>
        </>
      ) : (
        <form
          className="redflow-settings"
          onSubmit={(e) => void onSaveSettings(e)}
        >
          <p className="redflow-settings-hint">
            Token / 仓库在此填写。GitHub 域名授权须在扩展 Options
            页完成（商店安全限制，网页内无法弹授权窗）。
          </p>

          <label className="redflow-label">
            GitHub Token
            <input
              className="redflow-input"
              type="password"
              autoComplete="off"
              placeholder="ghp_..."
              value={settingsForm.githubToken}
              onChange={onSettingsChange("githubToken")}
            />
          </label>

          <div className="redflow-settings-row">
            <label className="redflow-label">
              Owner
              <input
                className="redflow-input"
                required
                placeholder="username"
                value={settingsForm.owner}
                onChange={onSettingsChange("owner")}
              />
            </label>
            <label className="redflow-label">
              Repo
              <input
                className="redflow-input"
                required
                placeholder="Info_flowPicker"
                value={settingsForm.repo}
                onChange={onSettingsChange("repo")}
              />
            </label>
          </div>

          <div className="redflow-settings-row">
            <label className="redflow-label">
              Branch
              <input
                className="redflow-input"
                placeholder="main"
                value={settingsForm.branch}
                onChange={onSettingsChange("branch")}
              />
            </label>
            <label className="redflow-label">
              Base Path
              <input
                className="redflow-input"
                placeholder="可选"
                value={settingsForm.basePath}
                onChange={onSettingsChange("basePath")}
              />
            </label>
          </div>

          <label className="redflow-label">
            Categories（逗号分隔）
            <input
              className="redflow-input"
              required
              placeholder="ai,food,travel"
              value={settingsForm.categories}
              onChange={onSettingsChange("categories")}
            />
          </label>

          <p className="redflow-perm-line">
            GitHub 权限：{githubOk ? "已授予" : "未授予"}
            {status?.itemCount != null ? ` · 本地 ${status.itemCount} 条` : ""}
          </p>

          {settingsMsg && <p className="redflow-settings-msg">{settingsMsg}</p>}

          <div className="redflow-footer redflow-footer-settings">
            <button type="submit" className="redflow-btn" disabled={saving}>
              {saving ? "保存中…" : "保存"}
            </button>
            <button
              type="button"
              className="redflow-btn redflow-btn-ghost"
              onClick={() => chrome.runtime.openOptionsPage()}
            >
              打开 Options 授权
            </button>
          </div>
          <button
            type="button"
            className="redflow-link-btn"
            onClick={() => void onClearHistory()}
          >
            清空发布标记
          </button>
        </form>
      )}

      {toast && <div className="redflow-toast">{toast}</div>}
    </aside>
  );
}
