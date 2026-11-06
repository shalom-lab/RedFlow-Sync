/**
 * ============================================================
 * 小红书「上传图文」Console 一键自测脚本（立即执行）
 * ============================================================
 *
 * 使用前：
 * 1. 浏览器打开并登录：
 *    https://creator.xiaohongshu.com/publish/publish?target=image
 * 2. 页面停在「上传图文」落地页（还没有标题输入框时最好）
 * 3. F12 → Console → 整段复制粘贴 → 回车
 *
 * 脚本会：
 * - 点一下「上传图文」Tab
 * - 用 canvas 生成一张测试 PNG
 * - 写入图文 file input 并触发 change
 * - 等待编辑态出现后，随便填标题和正文
 * - 全程 console 打印步骤，方便你对照哪里失败
 * ============================================================
 */
(async function redflowConsoleSelfTest() {
  "use strict";

  // ---------- 小工具 ----------
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const log = (...args) => console.log("%c[XHS自测]", "color:#e11d48;font-weight:bold", ...args);
  const ok = (...args) => console.log("%c[XHS自测✓]", "color:#16a34a;font-weight:bold", ...args);
  const fail = (...args) => console.error("%c[XHS自测✗]", "color:#dc2626;font-weight:bold", ...args);

  /** 元素是否大致可见 */
  function isVisible(el) {
    if (!el) return false;
    const style = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    return (
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      rect.width > 2 &&
      rect.height > 2
    );
  }

  /** accept 是否像「图片」而不是「视频」 */
  function isImageAccept(accept) {
    const a = String(accept || "").toLowerCase();
    if (!a) return false;
    // 纯视频 accept 直接排除
    if (a.includes("video") && !a.includes("image") && !/\.jpe?g|\.png|\.webp|\.gif/.test(a)) {
      return false;
    }
    return (
      a.includes("image") ||
      a.includes(".jpg") ||
      a.includes(".jpeg") ||
      a.includes(".png") ||
      a.includes(".webp") ||
      a.includes(".gif")
    );
  }

  /** 找标题输入框 */
  function findTitleInput() {
    return (
      document.querySelector('input[placeholder*="填写标题"]') ||
      document.querySelector('input[placeholder*="标题"]') ||
      document.querySelector('input[placeholder*="更多赞"]') ||
      null
    );
  }

  /** 找正文编辑器（TipTap / ProseMirror） */
  function findBodyEditor() {
    return (
      document.querySelector(".tiptap.ProseMirror") ||
      document.querySelector(".ProseMirror[contenteditable='true']") ||
      document.querySelector('.tiptap[contenteditable="true"]') ||
      null
    );
  }

  /** 找图文专用 file input（关键：不要选到视频那个） */
  function findImageFileInput() {
    // 优先：业界常用选择器
    const preferred = [
      'input[type="file"][accept*="jpg"]',
      'input[type="file"][accept*=".jpg"]',
      'input[type="file"][accept*="image"]',
      "input.upload-input[type='file']",
      ".upload-wrapper input[type='file']",
    ];
    for (const sel of preferred) {
      const el = document.querySelector(sel);
      if (el && isImageAccept(el.accept || "image")) return el;
    }

    // 回退：给所有 file input 打分
    const all = Array.from(document.querySelectorAll('input[type="file"]'));
    const ranked = all
      .map((input) => {
        const accept = (input.accept || "").toLowerCase();
        let score = 0;
        if (accept.includes("video") && !isImageAccept(accept)) score -= 50;
        if (accept.includes("image")) score += 10;
        if (/\.jpe?g|\.png|\.webp|\.gif/.test(accept)) score += 10;
        if ((input.className || "").includes("upload-input")) score += 3;
        return { input, score, accept, className: input.className };
      })
      .sort((a, b) => b.score - a.score);

    log("页面上所有 file input：", ranked);
    return ranked.find((x) => x.score > 0)?.input || null;
  }

  /** 用 canvas 现场生成一张测试图（不依赖外网） */
  async function makeTestImageFile() {
    const canvas = document.createElement("canvas");
    canvas.width = 720;
    canvas.height = 960;
    const ctx = canvas.getContext("2d");

    // 渐变底
    const g = ctx.createLinearGradient(0, 0, 720, 960);
    g.addColorStop(0, "#be123c");
    g.addColorStop(0.55, "#fb7185");
    g.addColorStop(1, "#ffe4e6");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 720, 960);

    // 文字
    ctx.fillStyle = "#ffffff";
    ctx.font = "bold 46px sans-serif";
    ctx.fillText("Console 自测图", 60, 180);
    ctx.font = "28px sans-serif";
    ctx.fillText(new Date().toLocaleString(), 60, 240);
    ctx.fillText("RedFlow smoke test", 60, 290);

    const blob = await new Promise((resolve, reject) => {
      canvas.toBlob(
        (b) => (b ? resolve(b) : reject(new Error("canvas.toBlob 失败"))),
        "image/png",
      );
    });

    return new File([blob], `console-test-${Date.now()}.png`, {
      type: "image/png",
    });
  }

  /** 把 File 写进 input.files，并触发事件（参考 OpenCLI） */
  function injectFile(input, file) {
    const dt = new DataTransfer();
    dt.items.add(file);

    // 1) 尝试直接赋值
    try {
      input.files = dt.files;
    } catch (e) {
      log("input.files 直接赋值失败，改用 defineProperty", e);
    }

    // 2) 强制覆盖 files getter（很多 React 页面更吃这套）
    try {
      Object.defineProperty(input, "files", {
        configurable: true,
        get: () => dt.files,
      });
    } catch (e) {
      log("defineProperty(files) 失败", e);
    }

    // 3) 触发页面监听
    input.dispatchEvent(new Event("change", { bubbles: true }));
    input.dispatchEvent(new Event("input", { bubbles: true }));

    return input.files?.length || 0;
  }

  /** 设置普通 input 的值（标题） */
  function setInputValue(el, value) {
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    )?.set;
    if (setter) setter.call(el, value);
    else el.value = value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  /** 往 contenteditable / TipTap 里塞正文 */
  function setBodyText(editor, text) {
    editor.focus();
    // 清空再插入
    document.execCommand("selectAll", false);
    document.execCommand("insertText", false, text);
    editor.dispatchEvent(new Event("input", { bubbles: true }));
  }

  // ==================== 开始执行 ====================
  log("开始。当前 URL =", location.href);

  // 0) 先短路定位 API，避免中途弹出「获取您的位置」打断自动化
  try {
    const fakeGeo = {
      getCurrentPosition(success, error) {
        if (typeof error === "function") {
          error({ code: 1, message: "Console自测：已静默定位", PERMISSION_DENIED: 1 });
        }
      },
      watchPosition(success, error) {
        if (typeof error === "function") {
          error({ code: 1, message: "Console自测：已静默定位", PERMISSION_DENIED: 1 });
        }
        return 0;
      },
      clearWatch() {},
    };
    Object.defineProperty(navigator, "geolocation", {
      configurable: true,
      get: () => fakeGeo,
    });
    log("已静默 navigator.geolocation（不再弹位置权限）");
  } catch (e) {
    log("静默 geolocation 失败（可忽略）", e);
  }

  // ① 尽量切到「上传图文」
  const tab = Array.from(
    document.querySelectorAll(".creator-tab, [class*='creator-tab'], div.tab"),
  ).find((el) => {
    const t = (el.textContent || "").replace(/\s+/g, "");
    return t.includes("上传图文") && isVisible(el);
  });
  if (tab) {
    tab.click();
    log("已点击「上传图文」Tab");
    await sleep(800);
  } else {
    log("没找到可见的「上传图文」Tab（可能已经在该页）");
  }

  // ② 找图文 file input
  const fileInput = findImageFileInput();
  if (!fileInput) {
    fail("找不到图文 file input。请确认：已登录、在发布页、且是「上传图文」而不是「上传视频」。");
    return;
  }
  ok("选中图文 input：", {
    accept: fileInput.accept,
    className: fileInput.className,
    multiple: fileInput.multiple,
    disabled: fileInput.disabled,
  });

  // ③ 生成测试图并注入
  const file = await makeTestImageFile();
  log("测试图已生成：", { name: file.name, size: file.size, type: file.type });

  if (fileInput.disabled) fileInput.disabled = false;
  const n = injectFile(fileInput, file);
  if (!n) {
    fail("写入 input.files 失败（files.length = 0）");
    return;
  }
  ok("已写入 files，数量 =", n, "开始等待编辑态（最多 25 秒）…");

  // ④ 等待标题/正文出现
  let ready = false;
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    if (findTitleInput() || findBodyEditor()) {
      ready = true;
      break;
    }
    await sleep(400);
  }

  if (!ready) {
    fail("超时：页面仍未出现标题/正文。常见原因：选错了视频 input、或页面拦截了合成 change。");
    fail("请手动点一下上传区选一张图，看手动是否能进编辑态，再回来对比。");
    return;
  }
  ok("已进入编辑态");

  // ⑤ 随便填几个字
  const titleEl = findTitleInput();
  const bodyEl = findBodyEditor();
  const titleText = "Console自测标题" + String(Date.now()).slice(-4);
  const bodyText =
    "这是一段 Console 自动填入的测试正文。\n如果能看到这段字，说明注入链路可用。\n#测试";

  if (titleEl) {
    setInputValue(titleEl, titleText);
    ok("标题已填：", titleText);
  } else {
    fail("进了编辑态但找不到标题框");
  }

  if (bodyEl) {
    setBodyText(bodyEl, bodyText);
    ok("正文已填（请肉眼看一下编辑器）");
  } else {
    fail("进了编辑态但找不到正文编辑器");
  }

  ok("自测结束。请在页面上确认：是否出现测试图 + 标题 + 正文。");
  ok("注意：本脚本不会点「发布」/「暂存离开」，只验证上传与填表。");
})();
