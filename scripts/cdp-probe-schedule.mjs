/**
 * CDP 探针：看小红书发布页「定时」相关 DOM（只读，不点红色发布）。
 *
 * 前置：Chrome --remote-debugging-port=9222，并打开 creator 发布页。
 * 用法：node scripts/cdp-probe-schedule.mjs
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
  console.log("[probe-schedule] target", target.url);

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", reject, { once: true });
  });

  const expr = `(() => {
    const textOf = (el) => (el?.innerText || el?.textContent || "").trim().slice(0, 80);
    const wrappers = [...document.querySelectorAll(
      ".post-time-wrapper, [class*='post-time'], [class*='schedule']",
    )]
      .slice(0, 12)
      .map((el) => ({
        tag: el.tagName,
        className: String(el.className || "").slice(0, 120),
        text: textOf(el),
      }));
    const hosts = [...document.querySelectorAll("[submit-text]")]
      .slice(0, 8)
      .map((el) => ({
        tag: el.tagName,
        submitText: el.getAttribute("submit-text"),
        className: String(el.className || "").slice(0, 120),
        text: textOf(el),
      }));
    return { wrappers, hosts, href: location.href };
  })()`;

  const result = await cdpCall(ws, 1, "Runtime.evaluate", {
    expression: expr,
    returnByValue: true,
  });
  console.log(JSON.stringify(result?.result?.value ?? result, null, 2));
  ws.close();
}

main().catch((err) => {
  console.error("[probe-schedule] fail", err);
  process.exitCode = 1;
});
