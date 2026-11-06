/**
 * CDP 探针：读发布页定时开关 / 底部 submit-text 当前态（只读）。
 *
 * 前置：Chrome --remote-debugging-port=9222，并打开 creator 发布页。
 * 用法：node scripts/cdp-probe-switch-state.mjs
 */
const CDP = "http://127.0.0.1:9222";

async function listPages() {
  const res = await fetch(`${CDP}/json/list`);
  if (!res.ok) throw new Error(`CDP list failed: ${res.status}`);
  return res.json();
}

function pickPublishTarget(pages) {
  const hit = pages.find(
    (p) =>
      p.type === "page" &&
      typeof p.url === "string" &&
      p.url.includes("creator.xiaohongshu.com") &&
      p.url.includes("publish"),
  );
  if (!hit?.webSocketDebuggerUrl) {
    throw new Error("未找到小红书发布页 target，请先打开 publish 页");
  }
  return hit;
}

function cdpCall(ws, id, method, params = {}) {
  return new Promise((resolve, reject) => {
    const onMsg = (ev) => {
      const raw = typeof ev.data === "string" ? ev.data : String(ev.data);
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }
      if (msg.id !== id) return;
      ws.removeEventListener("message", onMsg);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
    };
    ws.addEventListener("message", onMsg);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function main() {
  const pages = await listPages();
  const target = pickPublishTarget(pages);
  console.log("[probe-switch] target", target.url);

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", reject, { once: true });
  });

  const expr = `(() => {
    const wrap =
      document.querySelector(".post-time-wrapper") ||
      document.querySelector("[class*='post-time']");
    const sw =
      wrap?.querySelector(".el-switch, .d-switch, [class*='switch'], input[type='checkbox']") ||
      null;
    const host = document.querySelector("[submit-text]");
    const aria = sw?.getAttribute?.("aria-checked");
    const checked =
      sw instanceof HTMLInputElement
        ? sw.checked
        : aria === "true" ||
          /is-checked|is-active|checked/i.test(String(sw?.className || ""));
    return {
      href: location.href,
      hasWrapper: Boolean(wrap),
      wrapperClass: String(wrap?.className || "").slice(0, 160),
      switchTag: sw?.tagName || null,
      switchClass: String(sw?.className || "").slice(0, 160),
      ariaChecked: aria,
      checked,
      submitText: host?.getAttribute("submit-text") || null,
      hostText: (host?.innerText || "").trim().slice(0, 40),
    };
  })()`;

  const result = await cdpCall(ws, 1, "Runtime.evaluate", {
    expression: expr,
    returnByValue: true,
  });
  console.log(JSON.stringify(result?.result?.value ?? result, null, 2));
  ws.close();
}

main().catch((err) => {
  console.error("[probe-switch] fail", err);
  process.exitCode = 1;
});
