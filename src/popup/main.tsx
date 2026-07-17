import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { getConfig } from "@/lib/storage";
import "./popup.css";

function PopupApp() {
  const [ready, setReady] = useState(false);
  const [summary, setSummary] = useState("未配置");

  useEffect(() => {
    void getConfig().then((c) => {
      if (c.owner && c.repo) {
        setSummary(`${c.owner}/${c.repo} @ ${c.branch || "main"}`);
        setReady(true);
      }
    });
  }, []);

  return (
    <div className="pop">
      <div className="pop-brand">
        <span>RF</span>
        <strong>RedFlow-Sync</strong>
      </div>
      <p className="pop-repo">{summary}</p>
      <button type="button" onClick={() => chrome.runtime.openOptionsPage()}>
        {ready ? "打开设置" : "前往配置"}
      </button>
      <a
        className="pop-link"
        href="https://creator.xiaohongshu.com/publish/publish"
        target="_blank"
        rel="noreferrer"
      >
        打开小红书发布页
      </a>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<PopupApp />);
