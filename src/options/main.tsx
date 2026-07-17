import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { DEFAULT_CONFIG, type ExtensionConfig } from "@/types";
import { getConfig, saveConfig, clearUploadHistory } from "@/lib/storage";
import { requestGitHubAccess, hasGitHubAccess } from "@/lib/permissions";
import { sendRedFlow, type SyncStatusDTO } from "@/lib/messages";
import "./options.css";

function OptionsApp() {
  const [form, setForm] = useState<ExtensionConfig>(DEFAULT_CONFIG);
  const [saved, setSaved] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [githubOk, setGithubOk] = useState(false);
  const [status, setStatus] = useState<SyncStatusDTO | null>(null);
  const [syncing, setSyncing] = useState(false);

  const refreshStatus = async () => {
    const res = await sendRedFlow({ type: "GET_SYNC_STATUS" });
    if (res.ok && "status" in res) setStatus(res.status);
  };

  useEffect(() => {
    void getConfig().then(setForm);
    void hasGitHubAccess().then(setGithubOk);
    void refreshStatus();
  }, []);

  const onChange =
    (key: keyof ExtensionConfig) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      setForm((prev) => ({ ...prev, [key]: e.target.value }));
      setSaved(false);
    };

  const onSave = async (e: React.FormEvent) => {
    e.preventDefault();

    // 用户手势内直接 request（勿先 await contains）
    const granted = await requestGitHubAccess();
    setGithubOk(granted);
    if (!granted) {
      setSaved(false);
      setMessage("请在弹窗中允许访问 GitHub，否则无法拉取仓库数据");
      return;
    }

    const next = {
      ...form,
      owner: form.owner.trim(),
      repo: form.repo.trim(),
      branch: form.branch.trim() || "main",
      basePath: form.basePath.trim().replace(/^\/+|\/+$/g, ""),
      categories: form.categories.trim(),
      githubToken: form.githubToken.trim(),
    };
    if (!next.owner || !next.repo) {
      setMessage("Owner 与 Repo 必填");
      return;
    }
    if (!next.categories) {
      setMessage("请至少填写一个 category（英文逗号分隔）");
      return;
    }

    await saveConfig(next);
    setSaved(true);
    setMessage("配置与 GitHub 授权已保存，正在同步…");

    const syncRes = await sendRedFlow({ type: "SYNC_NOW", reason: "options-save" });
    if (!syncRes.ok) {
      setMessage(`已保存，同步失败：${syncRes.error}`);
    } else {
      if ("status" in syncRes) setStatus(syncRes.status);
      const r = "result" in syncRes ? syncRes.result : undefined;
      setMessage(
        r
          ? `已保存并同步：JSON ${r.fetchedJson} / 图片 ${r.fetchedImages} / 跳过 ${r.skipped}`
          : "已保存并同步完成",
      );
    }
  };

  const onSyncNow = async () => {
    const granted = await requestGitHubAccess();
    setGithubOk(granted);
    if (!granted) {
      setMessage("请先允许 GitHub 访问");
      return;
    }
    setSyncing(true);
    try {
      const res = await sendRedFlow({ type: "SYNC_NOW", reason: "options" });
      if (!res.ok) {
        setMessage(res.error);
      } else {
        const r = "result" in res ? res.result : undefined;
        if ("status" in res) setStatus(res.status);
        setMessage(
          r
            ? `增量同步完成：JSON ${r.fetchedJson} / 图片 ${r.fetchedImages} / 跳过 ${r.skipped}（${r.durationMs}ms）`
            : "增量同步完成",
        );
      }
    } finally {
      setSyncing(false);
      void refreshStatus();
    }
  };

  const onClearHistory = async () => {
    if (!confirm("确定清空全部已同步记录？卡片将重新显示为可导入。")) return;
    await clearUploadHistory();
    setMessage("已清空上传历史（不影响本地内容缓存）");
  };

  return (
    <div className="opt-page">
      <header className="opt-hero">
        <div className="opt-mark">RF</div>
        <div>
          <h1>RedFlow-Sync</h1>
          <p>连接 InfoFlow Picker 的 GitHub 仓库，半自动填入小红书发布页</p>
        </div>
      </header>

      <form className="opt-form" onSubmit={(e) => void onSave(e)}>
        <fieldset>
          <legend>GitHub 数据源</legend>

          <label>
            Personal Access Token
            <input
              type="password"
              autoComplete="off"
              placeholder="ghp_..."
              value={form.githubToken}
              onChange={onChange("githubToken")}
            />
          </label>

          <div className="opt-row">
            <label>
              Owner
              <input
                required
                placeholder="your-username"
                value={form.owner}
                onChange={onChange("owner")}
              />
            </label>
            <label>
              Repo
              <input
                required
                placeholder="Info_flowPicker"
                value={form.repo}
                onChange={onChange("repo")}
              />
            </label>
          </div>

          <div className="opt-row">
            <label>
              Branch
              <input
                placeholder="main"
                value={form.branch}
                onChange={onChange("branch")}
              />
            </label>
            <label>
              Base Path
              <input
                placeholder="如 data 或留空"
                value={form.basePath}
                onChange={onChange("basePath")}
              />
            </label>
          </div>

          <label>
            Categories（英文逗号分隔）
            <input
              placeholder="ai,food,travel"
              value={form.categories}
              onChange={onChange("categories")}
            />
          </label>
        </fieldset>

        <div className="opt-actions">
          <button type="submit" className="opt-primary">
            {saved ? "已保存" : "保存配置"}
          </button>
          <button
            type="button"
            className="opt-secondary"
            disabled={syncing}
            onClick={() => void onSyncNow()}
          >
            {syncing ? "同步中…" : "立即同步到本地"}
          </button>
          <button type="button" className="opt-secondary" onClick={() => void onClearHistory()}>
            清空发布标记
          </button>
        </div>

        {message && (
          <p className={`opt-msg ${saved || githubOk ? "" : "is-warn"}`}>
            {message}
          </p>
        )}
        <p className="opt-perm">
          GitHub 域名权限：{githubOk ? "已授予" : "未授予"} · 本地条目：
          {status?.itemCount ?? 0}
          {status?.lastSyncAt
            ? ` · 上次同步 ${new Date(status.lastSyncAt).toLocaleString()}`
            : " · 尚未同步"}
          {status?.lastError ? ` · 错误：${status.lastError}` : ""}
        </p>
      </form>

      <section className="opt-hint">
        <h2>使用说明</h2>
        <ol>
          <li>填写仓库信息并保存（会弹出 GitHub 访问授权）</li>
          <li>点「立即同步到本地」或等待后台每 6 小时增量同步</li>
          <li>打开小红书发布页，侧栏读本地缓存，导入不再每次拉网图</li>
        </ol>
        <p className="opt-path">
          数据路径：{"{basePath}/{category}/{fileId}.json"}　图片：
          {"{basePath}/Images/{category}/{fileId}.png"}
        </p>
      </section>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<OptionsApp />);
