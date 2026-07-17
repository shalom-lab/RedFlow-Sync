/**
 * 模块 D：核心 DOM 注入与图片跨域灌入
 *
 * 负责将标题、正文、图片写入小红书创作者发布页表单。
 * 所有选择器均提供多级回退；赋值后必须派发 input/change 以驱动 React 受控组件。
 */

import {
  hasGitHubAccess,
  githubAccessDeniedMessage,
} from "./permissions";

export interface FillTextPayload {
  title: string;
  body: string;
}

export interface FillImagePayload {
  fileId: string;
  /** raw.githubusercontent.com 图片地址 */
  imageUrl: string;
}

export interface DomFillSteps {
  title: boolean;
  body: boolean;
  image: boolean;
}

export class DomInjectError extends Error {
  readonly code:
    | "ELEMENT_NOT_FOUND"
    | "FETCH_FAILED"
    | "INVALID_BLOB"
    | "FILE_INPUT_LOCKED"
    | "UNKNOWN";

  constructor(
    code: DomInjectError["code"],
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "DomInjectError";
    this.code = code;
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * 设置原生 value，并触发 React 认可的 input 事件。
 * 优先走原生 value setter，避免被 React 内部追踪挡掉。
 */
function setNativeValue(
  el: HTMLInputElement | HTMLTextAreaElement,
  value: string,
): void {
  const proto =
    el instanceof HTMLTextAreaElement
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype;
  const descriptor = Object.getOwnPropertyDescriptor(proto, "value");
  if (descriptor?.set) {
    descriptor.set.call(el, value);
  } else {
    el.value = value;
  }

  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

function queryFirst<T extends Element>(
  selectors: string[],
  root: ParentNode = document,
): T | null {
  for (const sel of selectors) {
    try {
      const el = root.querySelector<T>(sel);
      if (el) return el;
    } catch {
      // 非法选择器跳过
    }
  }
  return null;
}

function findByPlaceholder(
  tag: "input" | "textarea",
  needles: string[],
): HTMLInputElement | HTMLTextAreaElement | null {
  const nodes = Array.from(document.querySelectorAll<HTMLElement>(tag));
  for (const node of nodes) {
    const ph = (node.getAttribute("placeholder") || "").toLowerCase();
    if (needles.some((n) => ph.includes(n.toLowerCase()))) {
      return node as HTMLInputElement | HTMLTextAreaElement;
    }
  }
  return null;
}

/** 标题输入框：优先 class，再 placeholder */
export function findTitleInput(): HTMLInputElement | null {
  const byClass = queryFirst<HTMLInputElement>([
    ".title-input input",
    ".title-container input",
    'input[class*="title"]',
    'div[class*="title"] input',
  ]);
  if (byClass) return byClass;

  const byPh = findByPlaceholder("input", [
    "填写标题",
    "标题",
    "title",
  ]) as HTMLInputElement | null;
  return byPh;
}

/** 正文：content-textarea / contenteditable / textarea */
export function findContentEditor():
  | HTMLTextAreaElement
  | HTMLElement
  | null {
  const textarea = queryFirst<HTMLTextAreaElement>([
    ".content-textarea",
    ".content-textarea textarea",
    'textarea[class*="content"]',
    'div[class*="content"] textarea',
  ]);
  if (textarea) return textarea;

  const editable = queryFirst<HTMLElement>([
    '.content-textarea [contenteditable="true"]',
    'div[class*="content"][contenteditable="true"]',
    '[contenteditable="true"][data-placeholder]',
    'div[contenteditable="true"]',
  ]);
  if (editable) return editable;

  return findByPlaceholder("textarea", [
    "添加正文",
    "正文",
    "输入正文",
    "描述",
  ]);
}

function findFileInput(): HTMLInputElement | null {
  const inputs = Array.from(
    document.querySelectorAll<HTMLInputElement>('input[type="file"]'),
  );

  // 优先接受图片的隐藏 input
  const imagePrefer = inputs.find((inp) => {
    const accept = (inp.accept || "").toLowerCase();
    return !accept || accept.includes("image") || accept.includes("*");
  });
  if (imagePrefer) return imagePrefer;
  return inputs[0] ?? null;
}

/**
 * 向 contenteditable 写入纯文本并尽量通知 React。
 */
function fillContentEditable(el: HTMLElement, text: string): void {
  el.focus();
  // 清空
  el.textContent = "";
  // 使用 execCommand 兼容部分编辑器（失败则回退 textContent）
  try {
    document.execCommand("selectAll", false);
    document.execCommand("insertText", false, text);
  } catch {
    el.textContent = text;
  }

  if ((el.textContent || "").trim() !== text.trim()) {
    el.textContent = text;
  }

  el.dispatchEvent(new InputEvent("input", { bubbles: true, data: text }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  el.dispatchEvent(new Event("blur", { bubbles: true }));
}

/** 填入标题 */
export async function fillTitle(title: string): Promise<void> {
  const input = findTitleInput();
  if (!input) {
    throw new DomInjectError(
      "ELEMENT_NOT_FOUND",
      "未找到标题输入框（.title-input input / placeholder）",
    );
  }
  input.focus();
  setNativeValue(input, title.slice(0, 20)); // 小红书标题通常有长度限制
  await sleep(50);
}

/** 填入正文（提示词 / content） */
export async function fillBody(body: string): Promise<void> {
  const editor = findContentEditor();
  if (!editor) {
    throw new DomInjectError(
      "ELEMENT_NOT_FOUND",
      "未找到正文输入区（.content-textarea / contenteditable）",
    );
  }

  editor.focus();
  if (editor instanceof HTMLTextAreaElement || editor instanceof HTMLInputElement) {
    setNativeValue(editor, body);
  } else {
    fillContentEditable(editor, body);
  }
  await sleep(50);
}

/**
 * 跨域下载图片 → Blob → File → DataTransfer 写入 file input
 */
export async function injectImageFromUrl(
  payload: FillImagePayload,
): Promise<void> {
  const { fileId, imageUrl } = payload;
  if (!imageUrl) {
    throw new DomInjectError("FETCH_FAILED", "图片 URL 为空");
  }

  if (!(await hasGitHubAccess())) {
    throw new DomInjectError("FETCH_FAILED", githubAccessDeniedMessage());
  }

  let response: Response;
  try {
    response = await fetch(imageUrl, {
      method: "GET",
      cache: "no-cache",
    });
  } catch (cause) {
    throw new DomInjectError(
      "FETCH_FAILED",
      `图片下载失败（网络错误）：${imageUrl}`,
      { cause },
    );
  }

  if (!response.ok) {
    throw new DomInjectError(
      "FETCH_FAILED",
      `图片下载失败 HTTP ${response.status}：${imageUrl}`,
    );
  }

  let blob: Blob;
  try {
    blob = await response.blob();
  } catch (cause) {
    throw new DomInjectError("INVALID_BLOB", "无法将响应转为 Blob", {
      cause,
    });
  }

  await injectImageBlob(fileId, blob);
}

/** 优先路径：使用本地 IndexedDB 缓存的 Blob，零网络 */
export async function injectImageBlob(
  fileId: string,
  blob: Blob,
): Promise<void> {
  if (!blob || blob.size === 0) {
    throw new DomInjectError("INVALID_BLOB", "图片 Blob 为空或大小为 0");
  }

  const mime =
    blob.type && blob.type.startsWith("image/")
      ? blob.type
      : "image/png";
  const ext = mime.includes("jpeg") || mime.includes("jpg") ? "jpg" : "png";
  const file = new File([blob], `${fileId}.${ext}`, { type: mime });

  const fileInput = findFileInput();
  if (!fileInput) {
    throw new DomInjectError(
      "ELEMENT_NOT_FOUND",
      '未找到 input[type="file"]，请确认当前在图文发布页且上传区已渲染',
    );
  }

  const wasDisabled = fileInput.disabled;
  if (wasDisabled) fileInput.disabled = false;

  try {
    const dt = new DataTransfer();
    dt.items.add(file);

    Object.defineProperty(fileInput, "files", {
      configurable: true,
      value: dt.files,
    });

    if (!fileInput.files || fileInput.files.length === 0) {
      try {
        const assignable = fileInput as HTMLInputElement & {
          files: FileList;
        };
        assignable.files = dt.files;
      } catch {
        throw new DomInjectError(
          "FILE_INPUT_LOCKED",
          "无法写入 file input.files（浏览器安全策略）",
        );
      }
    }

    if (!fileInput.files || fileInput.files.length === 0) {
      throw new DomInjectError(
        "FILE_INPUT_LOCKED",
        "file input 写入后仍为空",
      );
    }

    fileInput.dispatchEvent(new Event("input", { bubbles: true }));
    fileInput.dispatchEvent(new Event("change", { bubbles: true }));
  } finally {
    if (wasDisabled) fileInput.disabled = true;
  }

  await sleep(120);
}

/**
 * 一键填入：标题 + 正文 + 图片
 * 必须提供 imageBlob（由 Background 从 IDB / 远程拉取），Content Script 内不 fetch。
 */
export async function fillPublishForm(params: {
  fileId: string;
  title: string;
  body: string;
  imageBlob?: Blob;
}): Promise<DomFillSteps & { ok: boolean; error?: string }> {
  const steps: DomFillSteps = { title: false, body: false, image: false };
  const errors: string[] = [];

  try {
    await fillTitle(params.title);
    steps.title = true;
  } catch (e) {
    errors.push(e instanceof Error ? e.message : String(e));
  }

  try {
    await fillBody(params.body);
    steps.body = true;
  } catch (e) {
    errors.push(e instanceof Error ? e.message : String(e));
  }

  try {
    if (!params.imageBlob) {
      throw new DomInjectError(
        "INVALID_BLOB",
        "无本地图片，请先同步仓库后再导入",
      );
    }
    await injectImageBlob(params.fileId, params.imageBlob);
    steps.image = true;
  } catch (e) {
    errors.push(e instanceof Error ? e.message : String(e));
  }

  const ok = steps.title && steps.body && steps.image;
  return {
    ...steps,
    ok,
    error: errors.length ? errors.join("；") : undefined,
  };
}

/** 等待发布页关键表单节点出现（SPA 渲染延迟） */
export async function waitForPublishForm(
  timeoutMs = 15000,
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (findTitleInput() || findContentEditor() || findFileInput()) {
      return true;
    }
    await sleep(300);
  }
  return false;
}
