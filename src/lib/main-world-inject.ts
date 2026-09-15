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

/**
 * 页面主世界点合集：先点开「选择合集」，列表出现后再点 .item。
 * 整段自包含，供 chrome.scripting.executeScript({ world: "MAIN" }) 使用。
 */
export async function selectPublishMenuInMainWorld(
  kind: "collection" | "groupChat",
  name: string,
): Promise<MainWorldSelectResult> {
  if (kind !== "collection") return { ok: true };

  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  const norm = (s: string) => s.replace(/\s+/g, "").trim();
  const target = norm(name);
  if (!target) return { ok: false, error: "名称为空" };

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

export type MainWorldZancunResult = {
  ok: boolean;
  error?: string;
  text?: string;
  tag?: string;
};

/**
 * 暂存/定时按钮在 xhs-publish-btn 的 closed shadow 里，querySelector 看不见。
 * 宿主可查：save-text=暂存离开，submit-text=定时发布。
 * 内层 flex 居中：白按钮 120px + gap 24 + 红按钮 120px。
 * 用 elementFromPoint 打进 shadow，只点「暂存离开」。
 */
export async function clickZancunLeaveInMainWorld(): Promise<MainWorldZancunResult> {
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  const norm = (s: string) => s.replace(/\s+/g, "").trim();

  const isForbidden = (el: Element | null) => {
    if (!el) return true;
    const t = norm(el.textContent || "");
    const cls = String((el as HTMLElement).className || "");
    if (cls.includes("bg-red")) return true;
    if (t === "定时发布" || t === "发布") return true;
    return false;
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
      const saveOff = host.getAttribute("save-disabled") === "true";
      if (!saveOff && r.width >= 80 && r.height >= 24) break;
      host = null;
    }
    await sleep(150);
  }
  if (!host) return { ok: false, error: "未找到 xhs-publish-btn" };

  const saveText = host.getAttribute("save-text") || "";
  if (saveText && !saveText.includes("暂存")) {
    return { ok: false, error: `save-text 不是暂存离开：${saveText}` };
  }

  host.scrollIntoView({ block: "nearest", inline: "nearest" });
  await sleep(120);

  const rect = host.getBoundingClientRect();
  const groupW = 120 + 24 + 120;
  const groupLeft = rect.left + (rect.width - groupW) / 2;
  const y = rect.top + rect.height / 2;
  const xs = [groupLeft + 60, groupLeft + 40, groupLeft + 80, rect.left + rect.width / 2 - 72];

  for (const x of xs) {
    const stack = document.elementsFromPoint(x, y);
    const hit =
      stack.find((el) => {
        const t = norm(el.textContent || "");
        return el.tagName === "BUTTON" && t === "暂存离开";
      }) ||
      stack.find((el) => {
        const t = norm(el.textContent || "");
        return t === "暂存离开" && !isForbidden(el);
      });
    if (!hit || isForbidden(hit)) continue;
    fireAt(hit as HTMLElement, x, y);
    console.info("[RedFlow] 已点暂存离开", {
      tag: hit.tagName,
      text: norm(hit.textContent || ""),
      cls: String((hit as HTMLElement).className || "").slice(0, 80),
    });
    return {
      ok: true,
      text: norm(hit.textContent || ""),
      tag: hit.tagName,
    };
  }

  return {
    ok: false,
    error: "坐标未打到白色「暂存离开」（closed shadow）。请确认按钮已出现且未被挡住",
  };
}
