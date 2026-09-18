/**
 * WorkBuddy 同款两步注入（MAIN world）：
 * 1) 分块写入 window.__b64_0, __b64_1, ...
 * 2) atob 拼 File → input.upload-input.files = dt.files → change
 */

export type MainWorldImageFile = {
  name: string;
  type: string;
  /** 纯 base64，不含 data: 前缀 */
  base64: string;
};

export type MainWorldInjectResult =
  | {
      ok: true;
      count: number;
      bytes: number;
      accept: string;
      className: string;
    }
  | { ok: false; error: string };

/** CDP / executeScript 单次参数宜小，按字符切块挂到 window */
export const WINDOW_B64_CHUNK = 24 * 1024;

/** 与 Console / WorkBuddy 一致：立刻 error，避免定位回调挂死编辑态。 */
export function muteGeolocationInMainWorld(): void {
  const deny = (error?: PositionErrorCallback) => {
    if (typeof error !== "function") return;
    error({
      code: 1,
      message: "RedFlow: geolocation muted",
      PERMISSION_DENIED: 1,
      POSITION_UNAVAILABLE: 2,
      TIMEOUT: 3,
    } as GeolocationPositionError);
  };
  const fake: Geolocation = {
    getCurrentPosition(_success, error) {
      deny(error ?? undefined);
    },
    watchPosition(_success, error) {
      deny(error ?? undefined);
      return 0;
    },
    clearWatch() {},
  };
  Object.defineProperty(navigator, "geolocation", {
    configurable: true,
    get: () => fake,
  });
}

/** 步骤 1：chunk_and_send → window.__b64_{index} */
export function writeWindowB64Chunk(
  index: number,
  chunk: string,
  append: boolean,
): { ok: true; length: number } {
  const w = window as unknown as Record<string, string>;
  const key = `__b64_${index}`;
  w[key] = append ? String(w[key] || "") + chunk : chunk;
  return { ok: true, length: w[key].length };
}

/**
 * 步骤 2：与 WorkBuddy evaluate 同一逻辑
 * atob(window.__b64_i) → Uint8Array → File → upload-input.files + change
 */
export function assembleUploadInputFromWindowB64(
  names: string[],
  types: string[],
): MainWorldInjectResult {
  try {
    muteGeolocationInMainWorld();
  } catch {
    /* ignore */
  }

  const n = names.length;
  if (!n) return { ok: false, error: "无图片数据" };

  const w = window as unknown as Record<string, unknown>;
  const dt = new DataTransfer();
  let totalBytes = 0;

  for (let i = 0; i < n; i++) {
    const b64 = w[`__b64_${i}`];
    if (typeof b64 !== "string" || !b64) {
      return { ok: false, error: `window.__b64_${i} 为空` };
    }
    const bin = atob(b64);
    const a = new Uint8Array(bin.length);
    for (let j = 0; j < bin.length; j++) a[j] = bin.charCodeAt(j);
    const mime =
      types[i] && types[i].startsWith("image/") ? types[i] : "image/jpeg";
    const copy = new Uint8Array(a.byteLength);
    copy.set(a);
    dt.items.add(
      new File([copy.buffer], names[i] || `image-${i}.jpg`, { type: mime }),
    );
    totalBytes += a.byteLength;
    try {
      delete w[`__b64_${i}`];
    } catch {
      w[`__b64_${i}`] = "";
    }
  }
  if (totalBytes < 100) {
    return {
      ok: false,
      error: `解码后只有 ${totalBytes} 字节，不是正常图片`,
    };
  }

  const input =
    (document.querySelector(
      "input.upload-input",
    ) as HTMLInputElement | null) ||
    (document.querySelector(
      'input[type="file"][accept*="jpg"]',
    ) as HTMLInputElement | null);
  if (!input) {
    return { ok: false, error: "未找到 input.upload-input" };
  }
  const accept = (input.accept || "").toLowerCase();
  if (accept.includes("video") && !accept.includes("jpg") && !accept.includes("image")) {
    return { ok: false, error: "选中的是视频 input，已中止" };
  }
  if (input.disabled) input.disabled = false;

  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "files",
  )?.set;
  if (setter) setter.call(input, dt.files);
  else input.files = dt.files;

  const evInit = { bubbles: true, composed: true } as const;
  input.dispatchEvent(new Event("input", evInit));
  input.dispatchEvent(new Event("change", evInit));

  const zone =
    input.closest<HTMLElement>(
      ".upload-wrapper, .upload-container, .upload-content, [class*='upload']",
    ) ?? input;
  try {
    zone.dispatchEvent(
      new DragEvent("dragenter", {
        bubbles: true,
        cancelable: true,
        composed: true,
        dataTransfer: dt,
      }),
    );
    zone.dispatchEvent(
      new DragEvent("dragover", {
        bubbles: true,
        cancelable: true,
        composed: true,
        dataTransfer: dt,
      }),
    );
    zone.dispatchEvent(
      new DragEvent("drop", {
        bubbles: true,
        cancelable: true,
        composed: true,
        dataTransfer: dt,
      }),
    );
  } catch {
    /* DragEvent dataTransfer 在部分环境只读，忽略 */
  }

  const count = input.files?.length ?? 0;
  if (!count) {
    return { ok: false, error: "写入 input.files 后 length 仍为 0" };
  }

  return {
    ok: true,
    count,
    bytes: totalBytes,
    accept: input.accept || "",
    className: String(input.className || ""),
  };
}

export type MainWorldSelectResult = {
  ok: boolean;
  selected?: string;
  error?: string;
};

export type MainWorldAiDeclareResult = {
  ok: boolean;
  selected?: string;
  error?: string;
};

/**
 * executeScript 只序列化入口函数本身，外层闭包会丢。
 * 先注入本函数把工具挂到 window，后续 MAIN 入口只读 window.__rfMain。
 */
export type RedflowMainHelpers = {
  sleep: (ms: number) => Promise<void>;
  norm: (s: string) => string;
  visible: (el: HTMLElement | null) => el is HTMLElement;
  fireClick: (el: HTMLElement) => void;
  waitFor: (
    fn: () => HTMLElement | null,
    tries?: number,
  ) => Promise<HTMLElement | null>;
  AI_DECLARE_LABELS: string[];
};

type RedflowMainWindow = Window & { __rfMain?: RedflowMainHelpers };

/** 整段自包含，供 executeScript({ world: "MAIN" }) 使用。 */
export function ensureMainWorldHelpersInstalled(): boolean {
  const w = window as RedflowMainWindow;
  if (w.__rfMain) return true;

  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  const norm = (s: string) => s.replace(/\s+/g, "").trim();

  const visible = (el: HTMLElement | null): el is HTMLElement => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return (
      r.width > 4 &&
      r.height > 4 &&
      s.display !== "none" &&
      s.visibility !== "hidden" &&
      Number(s.opacity) >= 0.05
    );
  };

  const fireClick = (el: HTMLElement) => {
    el.scrollIntoView({ block: "center", inline: "nearest" });
    const r = el.getBoundingClientRect();
    const x = r.left + Math.max(r.width / 2, 4);
    const y = r.top + Math.max(r.height / 2, 4);
    const common: MouseEventInit = {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      clientX: x,
      clientY: y,
      screenX: x,
      screenY: y,
      button: 0,
      buttons: 1,
    };
    el.dispatchEvent(
      new PointerEvent("pointerdown", {
        ...common,
        pointerId: 1,
        pointerType: "mouse",
        isPrimary: true,
      }),
    );
    el.dispatchEvent(new MouseEvent("mousedown", common));
    el.dispatchEvent(
      new PointerEvent("pointerup", {
        ...common,
        pointerId: 1,
        pointerType: "mouse",
        isPrimary: true,
        buttons: 0,
      }),
    );
    el.dispatchEvent(new MouseEvent("mouseup", { ...common, buttons: 0 }));
    el.dispatchEvent(new MouseEvent("click", { ...common, buttons: 0 }));
    el.click();
  };

  const waitFor = async (
    fn: () => HTMLElement | null,
    tries = 40,
  ): Promise<HTMLElement | null> => {
    for (let i = 0; i < tries; i++) {
      const el = fn();
      if (el) return el;
      await sleep(100);
    }
    return fn();
  };

  w.__rfMain = {
    sleep,
    norm,
    visible,
    fireClick,
    waitFor,
    AI_DECLARE_LABELS: [
      "笔记含AI合成内容",
      "笔记含AI生成内容",
      "包含AI生成内容",
    ],
  };
  return true;
}

/** 仅在已注入 ensureMainWorldHelpersInstalled 后的 MAIN 入口内使用：直接读 window，勿再包一层外函数。 */

/**
 * 页面主世界点合集：先点开「选择合集」，列表出现后再点 .item。
 * 整段自包含，供 chrome.scripting.executeScript({ world: "MAIN" }) 使用。
 */
export async function selectPublishMenuInMainWorld(
  kind: "collection" | "groupChat",
  name: string,
): Promise<MainWorldSelectResult> {
  if (kind !== "collection") return { ok: true };

  const h = (window as RedflowMainWindow).__rfMain;
  if (!h) return { ok: false, error: "MAIN helpers 未安装" };
  const { sleep, norm, visible, fireClick, waitFor } = h;
  const target = norm(name);
  if (!target) return { ok: false, error: "名称为空" };

  const selectedText = () => {
    const el =
      document.querySelector<HTMLElement>(
        ".collection-plugin-choose .collection-name",
      ) ||
      document.querySelector<HTMLElement>(".collection-plugin-choose") ||
      document.querySelector<HTMLElement>(".collection-plugin-button");
    return norm(el?.textContent || "");
  };
  const cur = selectedText();
  if (cur.includes(target) && cur !== "选择合集") {
    return { ok: true, selected: cur };
  }

  const button =
    document.querySelector<HTMLElement>(".collection-plugin-button") ||
    document.querySelector<HTMLElement>(".collection-plugin-choose") ||
    Array.from(document.querySelectorAll<HTMLElement>("div")).find((el) => {
      if (!visible(el) || el.children.length > 8) return false;
      const t = norm(el.textContent || "");
      return t === "选择合集";
    }) ||
    null;
  if (!visible(button)) return { ok: false, error: "未找到「选择合集」按钮" };

  fireClick(button);

  const pop = await waitFor(() => {
    const p = document.querySelector<HTMLElement>(
      ".collection-plugin-popover, .collection-plugin-popover-content",
    );
    if (!visible(p)) return null;
    if (!p.querySelector(".item")) return null;
    return p;
  }, 50);
  if (!pop) return { ok: false, error: "点击「选择合集」后列表未出现" };

  const items = Array.from(pop.querySelectorAll<HTMLElement>(".item"));
  const match =
    items.find((el) => norm(el.textContent || "") === target) ||
    items.find((el) => norm(el.textContent || "").includes(target));
  if (!match) {
    return { ok: false, error: `合集列表没有「${name}」` };
  }
  fireClick(match);

  for (let i = 0; i < 25; i++) {
    await sleep(100);
    const now = selectedText();
    if (now.includes(target) && now !== "选择合集") {
      return { ok: true, selected: now };
    }
  }
  return { ok: false, error: "已点合集项但按钮文案未变", selected: selectedText() };
}

/**
 * 内容类型声明是 d-select（.custom-select-44），下拉常驻 DOM 但 display:none。
 * 普通点击打不开；实测可靠做法：强制显示 .declaration-drop-down，再点对应行的
 * .d-option-handler。选中后 .d-select-description 会变成「笔记含AI合成内容」。
 */
export async function declareAiContentInMainWorld(): Promise<MainWorldAiDeclareResult> {
  const h = (window as RedflowMainWindow).__rfMain;
  if (!h) return { ok: false, error: "MAIN helpers 未安装" };
  const { sleep, norm, fireClick, AI_DECLARE_LABELS } = h;
  const targetLabel = "笔记含AI合成内容";

  const selectedText = () => {
    const desc = document.querySelector<HTMLElement>(
      ".custom-select-44 .d-select-description",
    );
    return norm(desc?.textContent || "");
  };

  const cur = selectedText();
  if (AI_DECLARE_LABELS.some((l) => cur.includes(norm(l)))) {
    return { ok: true, selected: cur };
  }

  const expandContentSettings = async () => {
    if (document.querySelector(".custom-select-44")) return;
    const headers = Array.from(
      document.querySelectorAll<HTMLElement>(
        ".publish-page-content-setting-header, [class*='setting-header'], [class*='content-setting']",
      ),
    );
    for (const h of headers) {
      const t = h.textContent || "";
      if (!t.includes("内容设置")) continue;
      if (t.includes("收起")) return;
      fireClick(h);
      await sleep(350);
      return;
    }
  };

  await expandContentSettings();

  const wrap = document.querySelector<HTMLElement>(".custom-select-44");
  const pop = document.querySelector<HTMLElement>(
    ".declaration-drop-down, .custom-dropdown-44.declaration-drop-down, .d-popover.declaration-drop-down",
  );
  if (!wrap) return { ok: false, error: "未找到内容类型声明 d-select（.custom-select-44）" };
  if (!pop) {
    return {
      ok: false,
      error: "未找到声明下拉（.declaration-drop-down）",
    };
  }

  wrap.scrollIntoView({ block: "center", inline: "nearest" });
  await sleep(120);
  const wr = wrap.getBoundingClientRect();
  pop.style.display = "block";
  pop.style.visibility = "visible";
  pop.style.opacity = "1";
  pop.style.pointerEvents = "auto";
  pop.style.zIndex = "99999";
  pop.style.transform = `translate3d(${Math.round(wr.left)}px, ${Math.round(wr.bottom + 4)}px, 0px)`;
  await sleep(80);

  const nameEl = Array.from(
    pop.querySelectorAll<HTMLElement>(".d-option-name"),
  ).find((el) => {
    const t = norm(el.textContent || "");
    return AI_DECLARE_LABELS.some((l) => t === norm(l) || t.includes(norm(l)));
  });
  if (!nameEl) {
    return { ok: false, error: "下拉里没有「笔记含AI合成内容」" };
  }

  let clickTarget: HTMLElement = nameEl;
  const contentItem = nameEl.closest<HTMLElement>(".d-grid-item");
  const options = contentItem?.parentElement;
  if (contentItem && options) {
    const items = Array.from(
      options.querySelectorAll<HTMLElement>(":scope > .d-grid-item"),
    );
    const idx = items.indexOf(contentItem);
    const handler = items[idx - 2]?.querySelector<HTMLElement>(
      ".d-option-handler",
    );
    if (handler) clickTarget = handler;
  }

  fireClick(clickTarget);
  await sleep(200);

  for (let i = 0; i < 25; i++) {
    await sleep(100);
    const now = selectedText();
    if (AI_DECLARE_LABELS.some((l) => now.includes(norm(l)))) {
      console.info("[RedFlow] 已选 AI 内容声明", { selected: now });
      return { ok: true, selected: now || targetLabel };
    }
  }

  return {
    ok: false,
    error: "已点「笔记含AI合成内容」但 .d-select-description 未变",
    selected: selectedText() || undefined,
  };
}

export type MainWorldPickResult = {
  ok: boolean;
  selected?: string;
  error?: string;
  skipped?: boolean;
};

/**
 * 选择群聊：.group-card-select。
 * 注意：DOM 里常驻一份「暂无群聊」空态；不能一找到空态就 forceShow/跳过，
 * 要先点开并等待 `.item.custom-option`（或「我创建的群聊」）出现。
 */
export async function selectGroupChatInMainWorld(
  name = "",
): Promise<MainWorldPickResult> {
  try {
    const h = (window as RedflowMainWindow).__rfMain;
    if (!h) return { ok: false, error: "MAIN helpers 未安装" };
    const { sleep, norm, fireClick, visible } = h;
    const want = norm(name);

    const selectedText = () => {
      const wrap = document.querySelector<HTMLElement>(".group-card-select");
      const desc = wrap?.querySelector<HTMLElement>(".d-select-description");
      return norm(desc?.textContent || "");
    };

    const optionName = (el: HTMLElement) =>
      norm(
        el.querySelector<HTMLElement>(".group-info .name, .name")?.textContent ||
          el.textContent ||
          "",
      );

    const isPlaceholder = (t: string) =>
      !t || t === "选择群聊" || t.includes("暂无群聊");

    const cur = selectedText();
    if (!isPlaceholder(cur) && (!want || cur.includes(want))) {
      return { ok: true, selected: cur };
    }

    const wrap = document.querySelector<HTMLElement>(
      ".group-card-select, .group-card-wrapper .d-select-wrapper",
    );
    if (!wrap) return { ok: false, error: "未找到「选择群聊」" };

    const findOptionsPop = () => {
      const pops = Array.from(
        document.querySelectorAll<HTMLElement>(
          ".d-popover.d-dropdown.custom-dropdown-44",
        ),
      );
      // 优先：已有真实选项 / 「我创建的群聊」
      const withOpts = pops.find((p) => p.querySelector(".item.custom-option"));
      if (withOpts) return withOpts;
      return (
        pops.find((p) => norm(p.textContent || "").includes("我创建的群聊")) ||
        null
      );
    };

    const findEmptyPop = () => {
      const pops = Array.from(
        document.querySelectorAll<HTMLElement>(
          ".d-popover.d-dropdown.custom-dropdown-44",
        ),
      );
      return (
        pops.find((p) => {
          const t = norm(p.textContent || "");
          return t.includes("暂无群聊") && !p.querySelector(".item.custom-option");
        }) || null
      );
    };

    const forceShowPop = (pop: HTMLElement) => {
      const wr = wrap.getBoundingClientRect();
      pop.style.display = "block";
      pop.style.visibility = "visible";
      pop.style.opacity = "1";
      pop.style.pointerEvents = "auto";
      pop.style.zIndex = "99999";
      pop.style.transform = `translate3d(${Math.round(wr.left)}px, ${Math.round(wr.bottom + 4)}px, 0px)`;
    };

    wrap.scrollIntoView({ block: "center", inline: "nearest" });
    await sleep(250);
    // 先合成事件，再原生 click，触发 Vue 拉群列表
    fireClick(wrap);
    wrap.click();
    const main = wrap.querySelector<HTMLElement>(".d-select-main, .d-select");
    if (main) main.click();
    await sleep(400);

    // 等选项出现（不要立刻把常驻空态当最终结果）
    let pop: HTMLElement | null = null;
    let options: HTMLElement[] = [];
    for (let i = 0; i < 40; i++) {
      pop = findOptionsPop();
      if (pop) {
        options = Array.from(
          pop.querySelectorAll<HTMLElement>(".item.custom-option"),
        );
        if (options.length) break;
      }
      await sleep(150);
    }

    if (!options.length || !pop) {
      // 仍无选项：若空态可见则跳过；绝不 forceShow 空态去「假装打开」
      const empty = findEmptyPop();
      if (empty && visible(empty)) {
        document.body.click();
        return { ok: true, skipped: true, error: "暂无群聊，已跳过" };
      }
      // 再试一次打开并短等
      fireClick(wrap);
      wrap.click();
      await sleep(600);
      pop = findOptionsPop();
      options = pop
        ? Array.from(pop.querySelectorAll<HTMLElement>(".item.custom-option"))
        : [];
      if (!options.length) {
        document.body.click();
        return { ok: true, skipped: true, error: "暂无群聊，已跳过" };
      }
    }

    // 仅对「有选项」的 pop 必要时强制显示
    if (pop && !visible(pop)) {
      forceShowPop(pop);
      await sleep(120);
    }

    const target =
      (want && options.find((el) => optionName(el).includes(want))) ||
      options[0]!;

    // 选项必须用原生 click（与引用笔记同理）
    target.click();
    await sleep(150);
    const gridItem = target.closest<HTMLElement>(".d-grid-item");
    if (gridItem) gridItem.click();
    await sleep(200);

    for (let i = 0; i < 40; i++) {
      await sleep(120);
      const now = selectedText();
      if (!isPlaceholder(now) && (!want || now.includes(want))) {
        console.info("[RedFlow] 已选群聊", { selected: now });
        return { ok: true, selected: now };
      }
    }
    return {
      ok: false,
      error: "已点群聊但未选中",
      selected: selectedText() || undefined,
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * 引用笔记：打开弹窗 → 选中第一张笔记 → 「确认引用」。
 * 成功标准以「确认引用」可点为准（比看 --selected class 更稳）。
 */
export async function selectQuoteNoteFirstInMainWorld(): Promise<MainWorldPickResult> {
  try {
    const h = (window as RedflowMainWindow).__rfMain;
    if (!h) return { ok: false, error: "MAIN helpers 未安装" };
    const { sleep, norm, waitFor } = h;

    const quoteText = () =>
      norm(document.querySelector(".quote-note-container")?.textContent || "");

    const already = quoteText();
    if (
      already.includes("引用笔记") &&
      already.includes("《") &&
      already.length > 6
    ) {
      return { ok: true, selected: already };
    }

    const staleClose = document.querySelector<HTMLElement>(
      ".select-note-modal .d-modal-close",
    );
    if (staleClose) {
      staleClose.click();
      await sleep(300);
    }

    const trigger =
      document.querySelector<HTMLElement>(
        ".quote-note-container .setting-card",
      ) || document.querySelector<HTMLElement>(".quote-note-container");
    if (!trigger) return { ok: false, error: "未找到「引用笔记」" };

    trigger.scrollIntoView({ block: "center", inline: "nearest" });
    await sleep(300);
    trigger.click();
    await sleep(900);

    const modal = await waitFor(
      () => document.querySelector<HTMLElement>(".select-note-modal"),
      70,
    );
    if (!modal) return { ok: false, error: "未打开「选择笔记」弹窗" };

    const myTab = Array.from(
      modal.querySelectorAll<HTMLElement>(".select-note-modal__tab"),
    ).find((el) => norm(el.textContent || "") === "我的笔记");
    if (myTab && !String(myTab.className).includes("active")) {
      myTab.click();
      await sleep(500);
    }

    const card = await waitFor(() => {
      const el = modal.querySelector<HTMLElement>(
        ".select-note-modal__note-grid .note-card",
      );
      if (!el) return null;
      const r = el.getBoundingClientRect();
      const title = norm(
        el.querySelector(".note-card__title")?.textContent || "",
      );
      if (r.width < 40 || r.height < 40) return null;
      if (!title) return null;
      return el;
    }, 70);
    if (!card) {
      const cancel = Array.from(
        modal.querySelectorAll<HTMLElement>("button, .d-button"),
      ).find((el) => norm(el.textContent || "") === "取消");
      if (cancel) cancel.click();
      return { ok: true, skipped: true, error: "没有可引用的笔记，已跳过" };
    }

    const findEnabledConfirm = () =>
      Array.from(
        modal.querySelectorAll<HTMLElement>("button, .d-button"),
      ).find((el) => {
        if (norm(el.textContent || "") !== "确认引用") return false;
        if (String(el.className || "").includes("disabled")) return false;
        if (el.getAttribute("aria-disabled") === "true") return false;
        if (el instanceof HTMLButtonElement && el.disabled) return false;
        return true;
      }) || null;

    const clickCard = (el: HTMLElement) => {
      const r = el.getBoundingClientRect();
      const x = r.left + Math.max(r.width / 2, 4);
      const y = r.top + Math.max(r.height / 2, 4);
      const common: MouseEventInit = {
        bubbles: true,
        cancelable: true,
        composed: true,
        view: window,
        clientX: x,
        clientY: y,
        screenX: x,
        screenY: y,
        button: 0,
        buttons: 1,
      };
      el.dispatchEvent(new MouseEvent("mousedown", common));
      el.dispatchEvent(new MouseEvent("mouseup", { ...common, buttons: 0 }));
      el.dispatchEvent(new MouseEvent("click", { ...common, buttons: 0 }));
      el.click();
    };

    let confirm: HTMLElement | null = findEnabledConfirm();
    if (!confirm) {
      const titleEl = card.querySelector<HTMLElement>(".note-card__title");
      const coverEl = card.querySelector<HTMLElement>(
        ".note-card__cover, .note-card__cover-img, img",
      );
      const targets = [card, titleEl, coverEl, card].filter(
        (x): x is HTMLElement => Boolean(x),
      );

      for (let attempt = 0; attempt < 8 && !confirm; attempt++) {
        const t = targets[attempt % targets.length]!;
        t.scrollIntoView({ block: "center", inline: "nearest" });
        await sleep(80);
        clickCard(t);
        for (let j = 0; j < 12; j++) {
          await sleep(120);
          confirm = findEnabledConfirm();
          if (confirm) break;
        }
      }
    }

    if (!confirm) {
      const cancel = Array.from(
        modal.querySelectorAll<HTMLElement>("button, .d-button"),
      ).find((el) => norm(el.textContent || "") === "取消");
      if (cancel) cancel.click();
      return {
        ok: false,
        error: "未选中第一篇笔记，确认引用不可点",
      };
    }

    confirm.click();
    await sleep(600);

    for (let i = 0; i < 50; i++) {
      await sleep(120);
      if (!document.querySelector(".select-note-modal")) {
        const now = quoteText();
        console.info("[RedFlow] 已引用笔记", { selected: now });
        return { ok: true, selected: now };
      }
    }
    return {
      ok: false,
      error: "已点确认引用但弹窗未关闭",
      selected: quoteText(),
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export type FooterClickKind = "draft" | "schedule";

export type MainWorldZancunResult = {
  ok: boolean;
  error?: string;
  text?: string;
  tag?: string;
};

/**
 * 按钮在 xhs-publish-btn 的 closed shadow 里。
 * draft：点白色「暂存离开」；schedule：点红色「定时发布」（文案必须是定时发布，绝不点「发布」）。
 */
export async function clickZancunLeaveInMainWorld(
  kind: FooterClickKind = "draft",
): Promise<MainWorldZancunResult> {
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  const norm = (s: string) => s.replace(/\s+/g, "").trim();
  const wantSchedule = kind === "schedule";

  const isHit = (el: Element | null) => {
    if (!el) return false;
    const t = norm(el.textContent || "");
    const cls = String((el as HTMLElement).className || "");
    if (wantSchedule) {
      return cls.includes("bg-red") && t === "定时发布";
    }
    if (cls.includes("bg-red")) return false;
    if (t === "定时发布" || t === "发布") return false;
    return t === "暂存离开";
  };

  const fireAt = (el: HTMLElement, x: number, y: number) => {
    const common: MouseEventInit = {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      clientX: x,
      clientY: y,
      screenX: x,
      screenY: y,
      button: 0,
      buttons: 1,
    };
    el.dispatchEvent(
      new PointerEvent("pointerdown", {
        ...common,
        pointerId: 1,
        pointerType: "mouse",
        isPrimary: true,
      }),
    );
    el.dispatchEvent(new MouseEvent("mousedown", common));
    el.dispatchEvent(
      new PointerEvent("pointerup", {
        ...common,
        pointerId: 1,
        pointerType: "mouse",
        isPrimary: true,
        buttons: 0,
      }),
    );
    el.dispatchEvent(new MouseEvent("mouseup", { ...common, buttons: 0 }));
    el.dispatchEvent(new MouseEvent("click", { ...common, buttons: 0 }));
    if (typeof el.click === "function") el.click();
  };

  let host: HTMLElement | null = null;
  for (let i = 0; i < 50; i++) {
    host = document.querySelector("xhs-publish-btn");
    if (host) {
      const r = host.getBoundingClientRect();
      const blocked = wantSchedule
        ? host.getAttribute("submit-disabled") === "true"
        : host.getAttribute("save-disabled") === "true";
      const submitText = host.getAttribute("submit-text") || "";
      const ready =
        !blocked &&
        r.width >= 80 &&
        r.height >= 24 &&
        (!wantSchedule || submitText.includes("定时"));
      if (ready) break;
      host = null;
    }
    await sleep(150);
  }
  if (!host) {
    return {
      ok: false,
      error: wantSchedule
        ? "未找到可点的红色「定时发布」（请确认已勾选并填好定时）"
        : "未找到 xhs-publish-btn",
    };
  }

  if (wantSchedule) {
    const submitText = host.getAttribute("submit-text") || "";
    if (!submitText.includes("定时")) {
      return { ok: false, error: `红按钮是「${submitText || "发布"}」，未点，避免立即发布` };
    }
  } else {
    const saveText = host.getAttribute("save-text") || "";
    if (saveText && !saveText.includes("暂存")) {
      return { ok: false, error: `save-text 不是暂存离开：${saveText}` };
    }
  }

  host.scrollIntoView({ block: "nearest", inline: "nearest" });
  await sleep(120);

  const rect = host.getBoundingClientRect();
  const groupW = 120 + 24 + 120;
  const groupLeft = rect.left + (rect.width - groupW) / 2;
  const y = rect.top + rect.height / 2;
  const xs = wantSchedule
    ? [groupLeft + 204, groupLeft + 184, groupLeft + 224, rect.left + rect.width / 2 + 72]
    : [groupLeft + 60, groupLeft + 40, groupLeft + 80, rect.left + rect.width / 2 - 72];

  for (const x of xs) {
    const stack = document.elementsFromPoint(x, y);
    const hit = stack.find((el) => isHit(el));
    if (!hit) continue;
    fireAt(hit as HTMLElement, x, y);
    const text = norm(hit.textContent || "");
    console.info("[RedFlow] 已点底部按钮", {
      kind,
      tag: hit.tagName,
      text,
      cls: String((hit as HTMLElement).className || "").slice(0, 80),
    });
    return { ok: true, text, tag: hit.tagName };
  }

  return {
    ok: false,
    error: wantSchedule
      ? "坐标未打到红色「定时发布」。未勾选定时时红按钮是「发布」，不会点。"
      : "坐标未打到白色「暂存离开」（closed shadow）",
  };
}
