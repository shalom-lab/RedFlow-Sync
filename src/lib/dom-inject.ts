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
import { arrayBufferToBase64 } from "./base64";
import { formatXhsSchedule, parseXhsSchedule } from "./schedule";
import { paceForImages, paceForText, sleep, waitPace } from "./pace";
import { DEFAULT_COLLECTION_NAME } from "@/types";

export { DEFAULT_COLLECTION_NAME };

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
  /** 是否已选中目标合集 */
  collection?: boolean;
  /** 是否已选中群聊 */
  groupChat?: boolean;
  /** 话题是否已处理 */
  topics?: boolean;
  /** 是否已勾选定时并写入时间 */
  scheduled?: boolean;
  /** 写入的定时文案 YYYY-MM-DD HH:mm */
  scheduledAt?: string;
  /** 是否已点击「暂存离开」 */
  draftSaved?: boolean;
  /** 是否已勾选 AI 生成内容声明 */
  aiDeclared?: boolean;
  /** 是否已引用笔记 */
  quoteNote?: boolean;
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

async function waitUntil<T>(
  fn: () => T | false | null | undefined,
  timeoutMs: number,
): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = fn();
    if (value) return value;
    await sleep(150);
  }
  return fn() || null;
}

/** d-popover / d-select 只认指针序列，单纯 el.click() 经常打不开。 */
function nativePointerClick(el: HTMLElement): void {
  const rect = el.getBoundingClientRect();
  const x = rect.left + Math.max(rect.width / 2, 4);
  const y = rect.top + Math.max(rect.height / 2, 4);
  const common: MouseEventInit = {
    bubbles: true,
    cancelable: true,
    composed: true,
    clientX: x,
    clientY: y,
    screenX: x,
    screenY: y,
    button: 0,
    buttons: 1,
    view: window,
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
}

/**
 * 小红书上传过程可能触发 navigator.geolocation，弹出「获取位置」打断自动化。
 * 经 background 用 chrome.scripting（MAIN world）注入；不写页面 inline script（会被 CSP 拦）。
 */
export function mutePageGeolocation(): Promise<void> {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage({ type: "MUTE_GEOLOCATION" }, () => {
        void chrome.runtime.lastError;
        resolve();
      });
    } catch {
      resolve();
    }
  });
}

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

/** 标题：新版 `.c-input_inner` 是 wrapper DIV，真实 input 在内部 / placeholder */
export function findTitleInput(): HTMLInputElement | null {
  const byPh = findByPlaceholder("input", [
    "填写标题",
    "标题会有更多赞",
    "标题",
    "title",
  ]) as HTMLInputElement | null;
  if (byPh) return byPh;

  const wrap = queryFirst<HTMLElement>([
    ".c-input_inner",
    ".title-input",
    ".title-container",
    'div[class*="title"]',
  ]);
  if (wrap instanceof HTMLInputElement) return wrap;
  const nested = wrap?.querySelector<HTMLInputElement>("input");
  if (nested) return nested;

  return queryFirst<HTMLInputElement>([
    "input.c-input_inner",
    'input[class*="title"]',
    'div[class*="title"] input',
  ]);
}

/** 正文：新版 TipTap ProseMirror；兼容旧 #post-textarea */
export function findContentEditor():
  | HTMLTextAreaElement
  | HTMLElement
  | null {
  const tipTap = queryFirst<HTMLElement>([
    ".tiptap.ProseMirror",
    ".tiptap-container [contenteditable='true']",
    "div.ProseMirror[contenteditable='true']",
  ]);
  if (tipTap) return tipTap;

  const byId = queryFirst<HTMLTextAreaElement | HTMLElement>([
    "#post-textarea",
    "textarea#post-textarea",
    ".content-textarea",
    ".content-textarea textarea",
    'textarea[class*="content"]',
    'div[class*="content"] textarea',
  ]);
  if (byId) return byId;

  const editable = queryFirst<HTMLElement>([
    '#post-textarea[contenteditable="true"]',
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

/**
 * 图文上传 input。
 * 参考 auto-publish / OpenCLI / scriptscat：
 * - 必须选 accept 含图片的 input（绝不能落到视频 input）
 * - 优先 accept*=jpg / image
 * - 穿透 open shadowRoot
 */
function isImageFileAccept(accept: string): boolean {
  const a = (accept || "").toLowerCase();
  if (!a) return false;
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

function deepQuerySelectorAll<T extends Element>(
  selector: string,
  root: ParentNode = document,
): T[] {
  const results: T[] = [];
  const seen = new Set<ParentNode>();

  const collect = (scope: ParentNode) => {
    if (!scope || seen.has(scope)) return;
    seen.add(scope);
    try {
      const list =
        (scope as Document | ShadowRoot | Element).querySelectorAll?.(
          selector,
        ) ?? [];
      results.push(...Array.from(list as NodeListOf<T>));
    } catch {
      return;
    }
    const all =
      (scope as Document | ShadowRoot | Element).querySelectorAll?.("*") ?? [];
    for (const el of Array.from(all)) {
      if (el.shadowRoot) collect(el.shadowRoot);
    }
  };

  collect(root);
  return results;
}

function findFileInput(): HTMLInputElement | null {
  const all = deepQuerySelectorAll<HTMLInputElement>('input[type="file"]');
  const imageInputs = all.filter((inp) =>
    isImageFileAccept(inp.accept || ""),
  );
  const ranked = imageInputs
    .map((input) => {
      const accept = (input.accept || "").toLowerCase();
      let score = 0;
      if ((input.className || "").includes("upload-input")) score += 20;
      if (/\.jpe?g/.test(accept)) score += 10;
      if (accept.includes("image")) score += 8;
      if (/\.png|\.webp/.test(accept)) score += 5;
      if (accept.includes("video") && !isImageFileAccept(accept)) score -= 50;
      const wrap = input.closest(
        ".upload-wrapper, .upload-container, .upload-content, [class*='upload']",
      );
      if (wrap) score += 6;
      return { input, score };
    })
    .sort((a, b) => b.score - a.score);

  return ranked[0]?.input ?? null;
}

function isVisibleClickable(el: HTMLElement): boolean {
  if (el.getAttribute("aria-hidden") === "true") return false;
  const rect = el.getBoundingClientRect();
  if (rect.width < 4 || rect.height < 4) return false;
  if (rect.left < -100 || rect.top < -100) return false;
  const style = window.getComputedStyle(el);
  if (style.display === "none" || style.visibility === "hidden") return false;
  if (Number(style.opacity) < 0.05) return false;
  return true;
}

/** 可见的创作者 Tab（避开 left:-9999 / aria-hidden 辅助层） */
export function findCreatorTab(label: string): HTMLElement | null {
  const tabs = Array.from(
    document.querySelectorAll<HTMLElement>(
      ".creator-tab, [class*='creator-tab'], div.tab",
    ),
  );
  for (const tab of tabs) {
    const text = (tab.textContent || "").replace(/\s+/g, "");
    if (!text.includes(label.replace(/\s+/g, ""))) continue;
    if (!isVisibleClickable(tab)) continue;
    return tab;
  }
  return null;
}

/**
 * 找到可见的「上传图文」Tab（新版不一定带 .creator-tab）。
 * URL 带 target=image 也不等于已经点过这个按钮。
 */
function findUploadImageTab(): HTMLElement | null {
  const nodes = Array.from(document.querySelectorAll<HTMLElement>("*"));
  for (const el of nodes) {
    if (el.children.length > 3) continue;
    const text = (el.textContent || "").replace(/\s+/g, "").trim();
    if (text !== "上传图文") continue;
    if (!isVisibleClickable(el)) continue;
    return el;
  }
  return findCreatorTab("上传图文");
}

/**
 * 必须先点「上传图文」。仅靠 ?target=image 页面仍可能停在「上传视频」。
 */
export async function ensureImageNoteTab(): Promise<boolean> {
  // 已在图文落地页就别再点 Tab，避免 SPA 重挂载掐断通信
  if (findFileInput() && !findTitleInput() && !findContentEditor()) {
    return true;
  }

  const tab = findUploadImageTab();
  if (tab) {
    nativePointerClick(tab);
    await waitPace("tab");
  }

  for (let i = 0; i < 20; i++) {
    const input = findFileInput();
    if (input) return true;
    await sleep(220);
  }

  return Boolean(tab);
}

function findUploadDropzone(): HTMLElement | null {
  const selectors = [
    ".upload-wrapper",
    ".upload-container",
    ".upload-content",
    "[class*='upload-container']",
    ".drag-over",
  ];
  for (const sel of selectors) {
    const el = document.querySelector<HTMLElement>(sel);
    if (el && isVisibleClickable(el) && !(el instanceof HTMLInputElement)) {
      return el;
    }
  }
  const input = findFileInput();
  const wrap = input?.closest<HTMLElement>(
    "div, section, label, [class*='upload']",
  );
  if (wrap && wrap !== input && isVisibleClickable(wrap)) return wrap;
  return null;
}

/**
 * 注入前唤醒上传区：只派 pointer 事件，不 click 隐藏 file input（会弹出系统选文件框）。
 */
export async function primeUploadArea(): Promise<void> {
  const zone = findUploadDropzone();
  if (!zone) return;
  const rect = zone.getBoundingClientRect();
  const common: PointerEventInit = {
    bubbles: true,
    cancelable: true,
    composed: true,
    clientX: rect.left + rect.width / 2,
    clientY: rect.top + Math.min(rect.height / 2, 80),
    pointerId: 1,
    pointerType: "mouse",
    isPrimary: true,
  };
  zone.dispatchEvent(new PointerEvent("pointerdown", common));
  zone.dispatchEvent(new PointerEvent("pointerup", { ...common, buttons: 0 }));
  zone.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, composed: true }));
  await waitPace("click");
}

/**
 * 向 contenteditable 写入纯文本并尽量通知 React。
 */
function fillContentEditable(el: HTMLElement, text: string): void {
  el.focus();
  try {
    document.execCommand("selectAll", false);
    document.execCommand("delete", false);
  } catch {
    el.textContent = "";
  }

  const escapeHtml = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const lines = text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((s) => s.trimEnd())
    .filter((s) => s.length > 0);
  const html = lines
    .map((line) => `<p>${line.trim() ? escapeHtml(line) : "<br>"}</p>`)
    .join("");
  const inserted = document.execCommand("insertHTML", false, html);
  if (!inserted) {
    for (let i = 0; i < lines.length; i++) {
      if (i > 0) {
        try {
          document.execCommand("insertParagraph", false);
        } catch {
          document.execCommand("insertText", false, "\n");
        }
      }
      if (lines[i]) document.execCommand("insertText", false, lines[i]);
    }
  }

  el.dispatchEvent(new InputEvent("input", { bubbles: true, data: text }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  el.dispatchEvent(new Event("blur", { bubbles: true }));
}

/** 填入标题（Selenium: `.c-input_inner`） */
export async function fillTitle(title: string): Promise<void> {
  const input = findTitleInput();
  if (!input) {
    throw new DomInjectError(
      "ELEMENT_NOT_FOUND",
      "未找到标题输入框（.c-input_inner）",
    );
  }
  input.focus();
  setNativeValue(input, title.slice(0, 20));
  await sleep(paceForText(title, 420));
}

/** 填入正文（新版 TipTap / 旧 #post-textarea） */
export async function fillBody(body: string): Promise<void> {
  const editor = findContentEditor();
  if (!editor) {
    throw new DomInjectError(
      "ELEMENT_NOT_FOUND",
      "未找到正文输入区（#post-textarea）",
    );
  }

  editor.focus();
  if (editor instanceof HTMLTextAreaElement || editor instanceof HTMLInputElement) {
    setNativeValue(editor, body);
  } else {
    fillContentEditable(editor, body);
  }
  await sleep(paceForText(body, 650));
}

export async function ensureTopics(topics: string[]): Promise<boolean> {
  const names = topics.map((t) => t.replace(/^#+/, "").trim()).filter(Boolean);
  if (!names.length) return true;

  // 1) 正文里已有 #话题 时，再点工具栏「话题」强化插入（避免重复则跳过已存在）
  const editor = findContentEditor();
  const existing = (editor?.textContent || "").toLocaleLowerCase();

  let added = 0;
  for (const name of names) {
    if (existing.includes(`#${name.toLocaleLowerCase()}`)) {
      added += 1;
      continue;
    }
    const btn = document.querySelector<HTMLButtonElement>(
      "button.contentBtn.topic-btn, button.topic-btn",
    );
    if (btn && isVisibleClickable(btn)) {
      btn.click();
      await sleep(320);
    }
    const ed = findContentEditor();
    if (!ed) continue;
    ed.focus();
    try {
      document.execCommand("insertText", false, `#${name} `);
    } catch {
      ed.textContent = `${ed.textContent || ""}#${name} `;
      ed.dispatchEvent(new InputEvent("input", { bubbles: true }));
    }
    await sleep(420);
    // 若出现推荐标签且匹配则点选
    const tag = Array.from(
      document.querySelectorAll<HTMLElement>(
        ".recommend-topic-wrapper .tag, .suggestion .tag, span.tag",
      ),
    ).find((el) =>
      (el.textContent || "")
        .replace(/\s+/g, "")
        .includes(name.replace(/\s+/g, "")),
    );
    if (tag && isVisibleClickable(tag)) {
      tag.click();
      await sleep(280);
    }
    added += 1;
  }

  return added > 0;
}

function normalizeLabel(text: string): string {
  return text.replace(/\s+/g, "").trim();
}

function findVisibleByText(
  testers: Array<(t: string) => boolean>,
  maxChildren = 6,
): HTMLElement | null {
  const nodes = Array.from(document.querySelectorAll<HTMLElement>("*"));
  for (const el of nodes) {
    if (el.children.length > maxChildren) continue;
    if (!isVisibleClickable(el)) continue;
    const t = normalizeLabel(el.textContent || "");
    if (testers.some((fn) => fn(t))) return el;
  }
  return null;
}

function collectionTrigger(): HTMLElement | null {
  return (
    document.querySelector<HTMLElement>(".collection-plugin-button") ||
    document.querySelector<HTMLElement>(".collection-plugin-choose") ||
    findVisibleByText([(t) => t === "选择合集"], 6)
  );
}

function collectionSelectedName(): string {
  const el =
    document.querySelector<HTMLElement>(
      ".collection-plugin-choose .collection-name",
    ) ||
    document.querySelector<HTMLElement>(".collection-plugin-choose") ||
    document.querySelector<HTMLElement>(".collection-plugin-button");
  const t = normalizeLabel(el?.textContent || "");
  if (!t || t === "选择合集" || t === "加入合集") return "";
  return t;
}

function collectionPopover(): HTMLElement | null {
  const pop = document.querySelector<HTMLElement>(
    ".collection-plugin-popover, .collection-plugin-popover-content",
  );
  if (!pop || !isDisplayedBox(pop)) return null;
  if (!pop.querySelector(".item")) return null;
  return pop;
}

async function runMainWorldSelect(
  name: string,
): Promise<{ ok: boolean; selected?: string; error?: string }> {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(
        { type: "MAIN_WORLD_SELECT", kind: "collection", name },
        (response) => {
          void chrome.runtime.lastError;
          resolve(
            (response as { ok: boolean; selected?: string; error?: string }) || {
              ok: false,
              error: "无响应",
            },
          );
        },
      );
    } catch (e) {
      resolve({
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  });
}

async function runMainWorldDeclareAi(): Promise<{
  ok: boolean;
  selected?: string;
  error?: string;
}> {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage({ type: "MAIN_WORLD_DECLARE_AI" }, (response) => {
        void chrome.runtime.lastError;
        resolve(
          (response as { ok: boolean; selected?: string; error?: string }) || {
            ok: false,
            error: "无响应",
          },
        );
      });
    } catch (e) {
      resolve({
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  });
}

async function runMainWorldSelectGroup(name = ""): Promise<{
  ok: boolean;
  selected?: string;
  error?: string;
  skipped?: boolean;
}> {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(
        { type: "MAIN_WORLD_SELECT_GROUP", name },
        (response) => {
          void chrome.runtime.lastError;
          resolve(
            (response as {
              ok: boolean;
              selected?: string;
              error?: string;
              skipped?: boolean;
            }) || { ok: false, error: "无响应" },
          );
        },
      );
    } catch (e) {
      resolve({
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  });
}

async function runMainWorldSelectQuoteNote(): Promise<{
  ok: boolean;
  selected?: string;
  error?: string;
  skipped?: boolean;
}> {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(
        { type: "MAIN_WORLD_SELECT_QUOTE_NOTE" },
        (response) => {
          void chrome.runtime.lastError;
          resolve(
            (response as {
              ok: boolean;
              selected?: string;
              error?: string;
              skipped?: boolean;
            }) || { ok: false, error: "无响应" },
          );
        },
      );
    } catch (e) {
      resolve({
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  });
}

export async function selectGroupChat(name = ""): Promise<{
  ok: boolean;
  skipped?: boolean;
  selected?: string;
  error?: string;
}> {
  await expandContentSettings();
  const wrap = await waitUntil(
    () =>
      document.querySelector<HTMLElement>(
        ".group-card-select, .group-card-wrapper",
      ),
    10000,
  );
  if (!wrap) {
    return { ok: false, error: "未找到「选择群聊」（编辑页可能未加载完）" };
  }
  wrap.scrollIntoView({ block: "center", inline: "nearest" });
  await waitPace("menu");

  const main = await runMainWorldSelectGroup(name);
  if (main.ok) return main;
  return {
    ok: false,
    error: main.error || "选择群聊失败",
  };
}

export async function selectQuoteNoteFirst(): Promise<{
  ok: boolean;
  skipped?: boolean;
  selected?: string;
  error?: string;
}> {
  const trigger = await waitUntil(
    () =>
      document.querySelector<HTMLElement>(
        ".quote-note-container .setting-card, .quote-note-container",
      ),
    10000,
  );
  if (!trigger) {
    return { ok: false, error: "未找到「引用笔记」（编辑页可能未加载完）" };
  }
  trigger.scrollIntoView({ block: "center", inline: "nearest" });
  await waitPace("menu");

  const main = await runMainWorldSelectQuoteNote();
  if (main.ok) return main;
  return {
    ok: false,
    error: main.error || "引用笔记失败",
  };
}

function isDisplayedBox(el: HTMLElement): boolean {
  const style = window.getComputedStyle(el);
  if (style.display === "none" || style.visibility === "hidden") return false;
  if (Number(style.opacity) < 0.05) return false;
  const rect = el.getBoundingClientRect();
  return rect.width > 40 && rect.height > 24;
}

/** 已展开就不要再点标题，否则会把「内容设置」收起来。 */
async function expandContentSettings(): Promise<void> {
  const trigger = collectionTrigger();
  if (trigger && isVisibleClickable(trigger)) return;

  const settingHeaders = Array.from(
    document.querySelectorAll<HTMLElement>(
      ".publish-page-content-setting-header, [class*='setting-header'], [class*='content-setting']",
    ),
  );
  for (const h of settingHeaders) {
    const t = h.textContent || "";
    if (!t.includes("内容设置")) continue;
    if (t.includes("收起")) return;
    nativePointerClick(h);
    await waitPace("menu");
    break;
  }
}

async function expandMoreSettings(): Promise<void> {
  const schedule = findVisibleByText(
    [(t) => t === "定时发布", (t) => t.includes("定时发布") && t.length < 16],
    6,
  );
  if (schedule) return;

  const headers = Array.from(
    document.querySelectorAll<HTMLElement>(
      "[class*='content-settings'], [class*='setting-header']",
    ),
  );
  for (const h of headers) {
    const t = h.textContent || "";
    if (!t.includes("更多设置")) continue;
    if (t.includes("收起")) return;
    nativePointerClick(h);
    await waitPace("menu");
    break;
  }
}

/**
 * 先点「选择合集」.collection-plugin-button，等列表出来再点 .item。
 */
export async function selectCollection(
  collectionName: string = DEFAULT_COLLECTION_NAME,
): Promise<boolean> {
  const target = normalizeLabel(collectionName);
  if (!target) return false;

  await expandContentSettings();
  await waitUntil(() => collectionTrigger(), 8000);

  if (collectionSelectedName().includes(target)) return true;

  const trigger = collectionTrigger();
  if (trigger) {
    trigger.scrollIntoView({ block: "center", inline: "nearest" });
    await waitPace("click");
  }

  const main = await runMainWorldSelect(collectionName);
  if (main.ok) return true;

  const btn = collectionTrigger();
  if (!btn) return false;
  nativePointerClick(btn);
  const pop = await waitUntil(() => collectionPopover(), 5000);
  if (!pop) return false;
  const items = Array.from(pop.querySelectorAll<HTMLElement>(".item"));
  const match =
    items.find((el) => normalizeLabel(el.textContent || "") === target) ||
    items.find((el) => normalizeLabel(el.textContent || "").includes(target));
  if (!match) return false;
  nativePointerClick(match);
  await waitUntil(() => collectionSelectedName().includes(target), 2500);
  return collectionSelectedName().includes(target);
}

const AI_CONTENT_OPTION_MATCHERS: Array<(t: string) => boolean> = [
  (t) => t === "笔记含AI合成内容",
  (t) => t === "笔记含AI生成内容",
  (t) => t === "包含AI生成内容",
];

function findContentTypeSelect(): HTMLElement | null {
  return document.querySelector<HTMLElement>(".custom-select-44");
}

function findAiContentDropdownPanel(): HTMLElement | null {
  return document.querySelector<HTMLElement>(
    ".declaration-drop-down, .custom-dropdown-44.declaration-drop-down",
  );
}

function contentTypeSelectedText(): string {
  const desc = document.querySelector<HTMLElement>(
    ".custom-select-44 .d-select-description",
  );
  return normalizeLabel(desc?.textContent || "");
}

function isAiContentDeclared(): boolean {
  const t = contentTypeSelectedText();
  return AI_CONTENT_OPTION_MATCHERS.some((fn) => fn(t));
}

function findAiContentOptionHandler(): HTMLElement | null {
  const pop = findAiContentDropdownPanel();
  if (!pop) return null;
  const nameEl = Array.from(
    pop.querySelectorAll<HTMLElement>(".d-option-name"),
  ).find((el) =>
    AI_CONTENT_OPTION_MATCHERS.some((fn) =>
      fn(normalizeLabel(el.textContent || "")),
    ),
  );
  if (!nameEl) return null;
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
    if (handler) return handler;
  }
  return nameEl;
}

/** 下拉常驻 DOM 但 display:none，强制显示后再点选项。 */
function forceOpenContentTypeDropdown(): boolean {
  const wrap = findContentTypeSelect();
  const pop = findAiContentDropdownPanel();
  if (!wrap || !pop) return false;
  const wr = wrap.getBoundingClientRect();
  pop.style.display = "block";
  pop.style.visibility = "visible";
  pop.style.opacity = "1";
  pop.style.pointerEvents = "auto";
  pop.style.zIndex = "99999";
  pop.style.transform = `translate3d(${Math.round(wr.left)}px, ${Math.round(wr.bottom + 4)}px, 0px)`;
  return true;
}

/**
 * 在「添加内容类型声明」d-select 里选「笔记含AI合成内容」。
 * 优先 MAIN world（与合集同款）；失败再强制显示下拉兜底。
 */
export async function setDeclareAiContent(enabled: boolean): Promise<boolean> {
  if (!enabled) {
    if (!isAiContentDeclared()) return true;
    console.info("[RedFlow] 已声明 AI 内容，设置要求不声明，请手动取消");
    return true;
  }

  if (isAiContentDeclared()) return true;

  await expandContentSettings();
  await waitUntil(() => findContentTypeSelect(), 8000);

  const wrap = findContentTypeSelect();
  if (wrap) {
    wrap.scrollIntoView({ block: "center", inline: "nearest" });
    await waitPace("click");
  }

  const main = await runMainWorldDeclareAi();
  if (main.ok) {
    await waitUntil(() => isAiContentDeclared(), 2500);
    if (isAiContentDeclared()) return true;
  } else if (main.error) {
    console.warn("[RedFlow] MAIN world AI 声明", main.error);
  }

  if (!forceOpenContentTypeDropdown()) {
    console.warn("[RedFlow] 未找到内容类型声明 d-select / 下拉");
    return false;
  }
  await sleep(80);
  const item = findAiContentOptionHandler();
  if (!item) {
    console.warn("[RedFlow] 未找到「笔记含AI合成内容」菜单项");
    return false;
  }
  nativePointerClick(item);
  await waitPace("click");
  await waitUntil(() => isAiContentDeclared(), 2500);
  if (isAiContentDeclared()) return true;

  console.warn("[RedFlow] 已点「笔记含AI合成内容」但未检测到选中态");
  return false;
}

function findScheduleToggle(): HTMLElement | null {
  return (
    findVisibleByText(
      [
        (t) => t === "定时发布",
        (t) => t.includes("定时发布") && t.length < 16,
      ],
      6,
    ) ||
    document.querySelector<HTMLElement>(
      ".schedule-checkbox, .el-switch, [class*='schedule']",
    )
  );
}

function scheduleSwitchEl(toggle: HTMLElement): HTMLElement {
  const row = toggle.closest<HTMLElement>("div") || toggle;
  return (
    row.querySelector<HTMLElement>(
      ".d-switch, .el-switch, [role='switch'], input[type='checkbox']",
    ) || toggle
  );
}

function isSwitchOn(sw: HTMLElement): boolean {
  return (
    sw.classList.contains("is-checked") ||
    sw.classList.contains("is-active") ||
    (sw instanceof HTMLInputElement && sw.checked) ||
    sw.getAttribute("aria-checked") === "true"
  );
}

/** 存草稿时关掉定时，避免红按钮变成「定时发布」或误带定时。 */
export async function clearScheduledPublish(): Promise<void> {
  await expandMoreSettings();
  const toggle = findScheduleToggle();
  if (!toggle) return;
  const sw = scheduleSwitchEl(toggle);
  if (isSwitchOn(sw)) {
    nativePointerClick(sw);
    await waitPace("menu");
  }
}

/**
 * 勾选「定时发布」，把日期写进小红书允许范围内的日历（可能不是今天）。
 * 不点击红色「发布 / 定时发布」提交按钮。
 * 返回页面上实际生效的时间；失败返回 null。
 */
export async function setScheduledPublish(when: Date): Promise<Date | null> {
  const text = formatXhsSchedule(when);
  await expandMoreSettings();

  const toggle = findScheduleToggle();

  if (toggle) {
    const sw = scheduleSwitchEl(toggle);
    if (!isSwitchOn(sw)) {
      nativePointerClick(sw);
      await waitPace("menu");
    }
  } else {
    return null;
  }

  const editor =
    document.querySelector<HTMLElement>(
      ".el-date-editor, [class*='date-editor'], [class*='date-picker']",
    ) ||
    Array.from(document.querySelectorAll<HTMLElement>("*")).find((el) => {
      if (el.children.length > 6) return false;
      const t = (el.textContent || "").trim();
      return /^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}$/.test(t);
    });
  if (editor && isVisibleClickable(editor)) {
    nativePointerClick(editor);
    await waitPace("calendar");
  }

  const input =
    document.querySelector<HTMLInputElement>(
      ".el-date-editor input, .el-date-editor .el-input__inner, [class*='date-editor'] input, [class*='date-picker'] input",
    ) ||
    Array.from(document.querySelectorAll<HTMLInputElement>("input")).find(
      (el) =>
        (el.placeholder || "").includes("时间") ||
        /^\d{4}-\d{2}-\d{2}/.test(el.value || ""),
    );

  if (input) {
    input.focus();
    setNativeValue(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    input.dispatchEvent(new Event("blur", { bubbles: true }));
    await waitPace("click");
  }

  await pickCalendarDay(when);

  const hour = when.getHours();
  const minute = when.getMinutes();
  const hourEl = findVisibleByText(
    [(t) => t === `${hour}时`, (t) => t === `${hour}小时`],
    2,
  );
  if (hourEl) {
    nativePointerClick(hourEl);
    await waitPace("calendar");
  }
  const minuteEl = findVisibleByText(
    [(t) => t === `${minute}分`, (t) => t === `${minute}分钟`],
    2,
  );
  if (minuteEl) {
    nativePointerClick(minuteEl);
    await waitPace("calendar");
  }

  if (input && input.value.replace(/\s+/g, "") !== text.replace(/\s+/g, "")) {
    setNativeValue(input, text);
    input.dispatchEvent(new Event("change", { bubbles: true }));
    input.dispatchEvent(new Event("blur", { bubbles: true }));
  }

  await waitPace("step");
  const appliedText = input?.value?.trim() || text;
  return parseXhsSchedule(appliedText) ?? when;
}

function calendarHeaderShowsMonth(when: Date): boolean {
  const y = when.getFullYear();
  const m = when.getMonth() + 1;
  const want = [
    `${y}年${m}月`,
    `${y}年${String(m).padStart(2, "0")}月`,
    `${y}-${String(m).padStart(2, "0")}`,
  ];
  const labels = Array.from(
    document.querySelectorAll<HTMLElement>(
      ".el-date-picker__header-label, .el-picker-panel__icon-btn, [class*='picker-header'], [class*='date-picker']",
    ),
  );
  return labels.some((el) => {
    const t = (el.textContent || "").replace(/\s+/g, "");
    return want.some((w) => t.includes(w));
  });
}

function clickPickerNextMonth(): boolean {
  const btn =
    document.querySelector<HTMLElement>(
      ".el-icon-arrow-right, .el-date-picker__next-btn, .d-picker-header-next, button[aria-label*='下一'], [class*='arrow-right']",
    ) ||
    Array.from(document.querySelectorAll<HTMLElement>("button, span, i")).find(
      (el) => {
        const label = (el.getAttribute("aria-label") || el.textContent || "").trim();
        return label.includes("下个月") || label.includes("下一月");
      },
    );
  if (!btn || !isVisibleClickable(btn)) return false;
  nativePointerClick(btn);
  return true;
}

function isCurrentMonthDayCell(td: HTMLElement): boolean {
  if (td.classList.contains("prev-month") || td.classList.contains("next-month")) {
    return false;
  }
  if (td.classList.contains("disabled") || td.getAttribute("aria-disabled") === "true") {
    return false;
  }
  return true;
}

async function pickCalendarDay(when: Date): Promise<void> {
  for (let i = 0; i < 3; i++) {
    if (calendarHeaderShowsMonth(when)) break;
    if (!clickPickerNextMonth()) break;
    await waitPace("calendar");
  }

  const day = String(when.getDate());
  const cells = Array.from(
    document.querySelectorAll<HTMLElement>(
      ".el-date-table td, .d-date-table td, [class*='date-table'] td, td.available",
    ),
  );
  const match =
    cells.find((td) => {
      if (!isCurrentMonthDayCell(td)) return false;
      const t = (td.textContent || "").replace(/\s+/g, "").trim();
      return t === day || t === String(Number(day));
    }) ||
    cells.find((td) => {
      if (!isVisibleClickable(td)) return false;
      if (td.classList.contains("disabled")) return false;
      const t = (td.textContent || "").replace(/\s+/g, "").trim();
      return t === day || t === String(Number(day));
    });

  if (match && isVisibleClickable(match)) {
    nativePointerClick(match);
    await waitPace("calendar");
    return;
  }

  const available = cells.filter(
    (td) => isCurrentMonthDayCell(td) && isVisibleClickable(td),
  );
  if (available.length) {
    nativePointerClick(available[Math.floor(Math.random() * available.length)]!);
    await waitPace("calendar");
  }
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

function buildImageFiles(fileId: string, blobs: Blob[]): File[] {
  return blobs.slice(0, 9).map((b, i) => {
    const mime =
      b.type && b.type.startsWith("image/") ? b.type : "image/png";
    const ext =
      mime.includes("jpeg") || mime.includes("jpg")
        ? "jpg"
        : mime.includes("webp")
          ? "webp"
          : "png";
    const name =
      blobs.length > 1 ? `${fileId}-${i + 1}.${ext}` : `${fileId}.${ext}`;
    return new File([b], name, { type: mime });
  });
}

/**
 * 上传图片：WorkBuddy 两步法
 * 1) 分块写入 window.__b64_i
 * 2) 页面内 atob → File → input.upload-input.files + change
 */
export async function injectImageBlob(
  fileId: string,
  blob: Blob | Blob[],
  category?: string,
): Promise<void> {
  await mutePageGeolocation();

  const blobs = Array.isArray(blob) ? blob : [blob];
  if (!blobs.length || blobs.some((b) => !b || b.size === 0)) {
    throw new DomInjectError("INVALID_BLOB", "图片 Blob 为空或大小为 0");
  }
  if (blobs.some((b) => b.size < 100)) {
    throw new DomInjectError(
      "INVALID_BLOB",
      `图片只有 ${blobs.map((b) => b.size).join(",")} 字节，不是正常图片（常见原因：扩展消息把 ArrayBuffer 传丢了）`,
    );
  }

  const built = buildImageFiles(fileId, blobs);
  const files = await Promise.all(
    built.map(async (f) => ({
      name: f.name,
      type: f.type || "image/png",
      base64: arrayBufferToBase64(await f.arrayBuffer()),
    })),
  );

  const res = await new Promise<{
    ok: boolean;
    error?: string;
    count?: number;
    bytes?: number;
    accept?: string;
    className?: string;
  }>((resolve) => {
    try {
      chrome.runtime.sendMessage(
        {
          type: "INJECT_IMAGE_FILES",
          category,
          fileId,
          files: category ? undefined : files,
        },
        (response) => {
          void chrome.runtime.lastError;
          resolve(
            (response as {
              ok: boolean;
              error?: string;
              count?: number;
              bytes?: number;
              accept?: string;
              className?: string;
            }) || { ok: false, error: "无响应" },
          );
        },
      );
    } catch (e) {
      resolve({
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  });

  if (!res.ok) {
    throw new DomInjectError(
      res.error?.includes("input") ? "ELEMENT_NOT_FOUND" : "FILE_INPUT_LOCKED",
      res.error || "MAIN world 注入图片失败",
    );
  }

  console.info("[RedFlow] image input (MAIN)", {
    accept: res.accept,
    className: res.className,
    count: res.count,
    bytes: res.bytes,
  });

  const bytes = blobs.reduce((sum, b) => sum + b.size, 0);
  await sleep(paceForImages(blobs.length, bytes));
}

/**
 * 底部按钮在 closed shadow 内，光 DOM 只能找到宿主 xhs-publish-btn。
 * 扩展可用 chrome.dom.openOrClosedShadowRoot 打开 closed root。
 */
export function findPublishBtnHost(): HTMLElement | null {
  const el = document.querySelector<HTMLElement>("xhs-publish-btn");
  if (!el) return null;
  const rect = el.getBoundingClientRect();
  if (rect.width < 80 || rect.height < 24) return null;
  return el;
}

function pickFooterButton(
  root: ParentNode,
  kind: "draft" | "schedule",
): HTMLButtonElement | null {
  const bar = root.querySelector(".publish-page-publish-btn");
  const buttons = Array.from(
    (bar ?? root).querySelectorAll("button"),
  ) as HTMLButtonElement[];
  if (kind === "schedule") {
    return (
      buttons.find((b) => {
        const t = (b.textContent || "").replace(/\s+/g, "").trim();
        return b.classList.contains("bg-red") && t === "定时发布";
      }) ?? null
    );
  }
  return (
    buttons.find((b) => {
      const t = (b.textContent || "").replace(/\s+/g, "").trim();
      return t === "暂存离开" && !b.classList.contains("bg-red");
    }) ?? null
  );
}

export async function clickPublishFooter(
  kind: "draft" | "schedule" = "draft",
): Promise<boolean> {
  const host = await waitUntil(() => {
    const el = findPublishBtnHost();
    if (!el) return null;
    if (kind === "schedule") {
      if (el.getAttribute("submit-disabled") === "true") return null;
      const submit = el.getAttribute("submit-text") || "";
      if (!submit.includes("定时")) return null;
    } else if (el.getAttribute("save-disabled") === "true") {
      return null;
    }
    return el;
  }, 12000);
  if (!host) {
    console.warn(
      kind === "schedule"
        ? "[RedFlow] 未找到可点的红色「定时发布」"
        : "[RedFlow] 未找到 xhs-publish-btn 宿主",
    );
    return false;
  }

  const shadow = chrome.dom.openOrClosedShadowRoot(host);
  const btn = shadow ? pickFooterButton(shadow, kind) : null;
  if (btn) {
    btn.scrollIntoView({ block: "nearest", inline: "nearest" });
    await waitPace("click");
    nativePointerClick(btn);
    btn.click();
    console.info(
      kind === "schedule"
        ? "[RedFlow] 已点 closed-shadow「定时发布」"
        : "[RedFlow] 已点 closed-shadow「暂存离开」",
    );
    await waitPace("step");
    return true;
  }

  const main = await new Promise<{ ok?: boolean; error?: string }>((resolve) => {
    try {
      chrome.runtime.sendMessage(
        { type: "MAIN_WORLD_CLICK_ZANCUN", kind },
        (response) => {
          void chrome.runtime.lastError;
          resolve(
            (response as { ok?: boolean; error?: string }) || {
              ok: false,
              error: "无响应",
            },
          );
        },
      );
    } catch (e) {
      resolve({
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  });

  if (main.ok) {
    await waitPace("step");
    return true;
  }

  console.warn("[RedFlow] 点击底部按钮失败", kind, main.error);
  return false;
}

/** @deprecated 使用 clickPublishFooter("draft") */
export async function clickZancunLeave(): Promise<boolean> {
  return clickPublishFooter("draft");
}

export type PublishPhase = "upload" | "edit" | "unknown";

export function detectPublishPhase(): PublishPhase {
  if (findTitleInput() || findContentEditor()) return "edit";
  if (findFileInput() || findUploadImageTab()) return "upload";
  return "unknown";
}

/**
 * 不刷新整页：点「上传图文 / 发布笔记」回到可灌图的落地页。
 */
export async function preparePublishLanding(): Promise<{
  ok: boolean;
  phase: PublishPhase;
  error?: string;
}> {
  await mutePageGeolocation();
  let phase = detectPublishPhase();

  if (phase === "edit") {
    const entry =
      findVisibleByText(
        [(t) => t === "发布笔记", (t) => t === "去发布"],
        4,
      ) || findUploadImageTab();
    if (entry) {
      nativePointerClick(entry);
      await waitPace("nav");
    }
    phase = detectPublishPhase();
  }

  try {
    await ensureImageNoteTab();
  } catch (e) {
    return {
      ok: false,
      phase: detectPublishPhase(),
      error: e instanceof Error ? e.message : String(e),
    };
  }

  phase = detectPublishPhase();
  if (phase === "unknown" && !findFileInput()) {
    return {
      ok: false,
      phase,
      error: "未找到「上传图文」Tab，请先打开图文发布页（不必刷新）",
    };
  }
  return { ok: true, phase };
}

/** 只灌图并立刻回包。等编辑页由侧栏 PING，避免页面跳转掐断通道。 */
export async function uploadPublishImages(params: {
  fileId: string;
  category?: string;
  imageBlob: Blob | Blob[];
}): Promise<{ ok: boolean; error?: string }> {
  await mutePageGeolocation();
  const phase = detectPublishPhase();
  if (phase !== "edit") {
    const switched = await ensureImageNoteTab();
    if (!switched && !findFileInput()) {
      return { ok: false, error: "未找到「上传图文」，无法灌图" };
    }
    await waitPace("tab");
    await primeUploadArea();
  }

  try {
    await injectImageBlob(params.fileId, params.imageBlob, params.category);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** 编辑页：标题 / 正文 / 话题 / 合集 / 定时。不点暂存。 */
export async function fillPublishText(params: {
  title: string;
  body: string;
  collectionName?: string;
  scheduledAt?: string;
  topics?: string[];
  /** 默认 true：勾选 AI 生成内容声明 */
  declareAiContent?: boolean;
  groupChatEnabled?: boolean;
  groupChatName?: string;
  quoteNoteEnabled?: boolean;
}): Promise<DomFillSteps & { ok: boolean; error?: string }> {
  const steps: DomFillSteps = {
    title: false,
    body: false,
    image: true,
    collection: false,
    groupChat: false,
    topics: false,
    scheduled: false,
    draftSaved: false,
    aiDeclared: false,
    quoteNote: false,
  };
  const errors: string[] = [];
  const collectionName = params.collectionName || DEFAULT_COLLECTION_NAME;

  if (!(findTitleInput() || findContentEditor())) {
    return {
      ...steps,
      image: false,
      ok: false,
      error: "还没进入编辑页（标题/正文未出现）",
    };
  }

  await waitPace("step");

  try {
    await fillTitle(params.title);
    steps.title = true;
  } catch (e) {
    errors.push(e instanceof Error ? e.message : String(e));
  }

  await waitPace("step");

  try {
    await fillBody(params.body);
    steps.body = true;
  } catch (e) {
    errors.push(e instanceof Error ? e.message : String(e));
  }

  await waitPace("step");

  if (params.topics?.length) {
    try {
      steps.topics = await ensureTopics(params.topics);
    } catch (e) {
      errors.push(e instanceof Error ? e.message : String(e));
    }
  } else {
    steps.topics = true;
  }

  await waitPace("menu");

  try {
    steps.collection = await selectCollection(collectionName);
    if (!steps.collection) {
      errors.push(`未选中合集「${collectionName}」，请手动选择`);
    }
  } catch (e) {
    errors.push(e instanceof Error ? e.message : String(e));
  }

  await waitPace("menu");

  if (params.groupChatEnabled !== false) {
    try {
      const group = await selectGroupChat(params.groupChatName || "");
      steps.groupChat = Boolean(group.ok && !group.skipped);
      if (!group.ok) {
        errors.push(group.error || "选择群聊失败");
      } else if (group.skipped) {
        console.info("[RedFlow] 群聊跳过", group.error);
        steps.groupChat = true; // 无群聊不视为失败
      }
    } catch (e) {
      errors.push(e instanceof Error ? e.message : String(e));
    }
    await waitPace("menu");
  } else {
    steps.groupChat = true;
  }

  if (params.quoteNoteEnabled !== false) {
    try {
      const quote = await selectQuoteNoteFirst();
      steps.quoteNote = Boolean(quote.ok && !quote.skipped);
      if (!quote.ok) {
        errors.push(quote.error || "引用笔记失败");
      } else if (quote.skipped) {
        console.info("[RedFlow] 引用笔记跳过", quote.error);
        steps.quoteNote = true;
      }
    } catch (e) {
      errors.push(e instanceof Error ? e.message : String(e));
    }
    await waitPace("menu");
  } else {
    steps.quoteNote = true;
  }

  const wantAi = params.declareAiContent !== false;
  try {
    steps.aiDeclared = await setDeclareAiContent(wantAi);
    if (wantAi && !steps.aiDeclared) {
      errors.push("未选中「笔记含AI合成内容」，请手动在「添加内容类型声明」里选择");
    }
  } catch (e) {
    errors.push(e instanceof Error ? e.message : String(e));
  }

  await waitPace("menu");

  if (params.scheduledAt) {
    try {
      const when = new Date(params.scheduledAt);
      const applied = await setScheduledPublish(when);
      steps.scheduled = Boolean(applied);
      steps.scheduledAt = formatXhsSchedule(applied ?? when);
      if (!steps.scheduled) {
        errors.push(`未写上定时「${steps.scheduledAt}」，请手动勾选定时发布`);
      }
    } catch (e) {
      errors.push(e instanceof Error ? e.message : String(e));
    }
  } else {
    try {
      await clearScheduledPublish();
    } catch {
      /* 关掉定时失败不阻断存草稿 */
    }
  }

  await waitPace("step");
  await waitUntil(() => findPublishBtnHost(), 8000);

  const ok = steps.title && steps.body;
  return {
    ...steps,
    ok,
    error: errors.length ? errors.join("；") : undefined,
  };
}

/**
 * 一键填入（同页内用）。自动化请走拆步消息，避免灌图跳转掐断通道。
 */
export async function fillPublishForm(params: {
  fileId: string;
  category?: string;
  title: string;
  body: string;
  imageBlob?: Blob | Blob[];
  collectionName?: string;
  scheduledAt?: string;
  topics?: string[];
  declareAiContent?: boolean;
  groupChatEnabled?: boolean;
  groupChatName?: string;
  quoteNoteEnabled?: boolean;
  saveDraft?: boolean;
}): Promise<DomFillSteps & { ok: boolean; error?: string }> {
  const hasImages = Boolean(
    params.imageBlob &&
      (Array.isArray(params.imageBlob)
        ? params.imageBlob.length > 0
        : params.imageBlob.size > 0),
  );

  await preparePublishLanding();

  if (hasImages && detectPublishPhase() !== "edit") {
    const up = await uploadPublishImages({
      fileId: params.fileId,
      category: params.category,
      imageBlob: params.imageBlob!,
    });
    if (!up.ok) {
      return {
        title: false,
        body: false,
        image: false,
        ok: false,
        error: up.error,
      };
    }
    const onEdit = await waitForEditFields(25000);
    if (!onEdit) {
      return {
        title: false,
        body: false,
        image: true,
        ok: false,
        error:
          "图片已注入，但页面未进入编辑态。请确认在「上传图文」页。",
      };
    }
  } else if (!hasImages && detectPublishPhase() !== "edit") {
    return {
      title: false,
      body: false,
      image: false,
      ok: false,
      error:
        "当前还在上传落地页且本地暂无图片。请确认 infoflow-data/Prompt/{id}.json 的 image/images 可下载。",
    };
  }

  const filled = await fillPublishText({
    title: params.title,
    body: params.body,
    collectionName: params.collectionName,
    scheduledAt: params.scheduledAt,
    topics: params.topics,
    declareAiContent: params.declareAiContent,
    groupChatEnabled: params.groupChatEnabled,
    groupChatName: params.groupChatName,
    quoteNoteEnabled: params.quoteNoteEnabled,
  });

  if (params.saveDraft !== false && filled.ok) {
    try {
      await waitPace("step");
      const draftSaved = await clickZancunLeave();
      return {
        ...filled,
        draftSaved,
        error: draftSaved
          ? filled.error
          : [filled.error, "已填入文案，但未点到「暂存离开」"]
              .filter(Boolean)
              .join("；"),
      };
    } catch (e) {
      return {
        ...filled,
        draftSaved: false,
        error: e instanceof Error ? e.message : String(e),
      };
    }
  }

  return filled;
}

/** 等待发布页关键节点（含图文上传区） */
export async function waitForPublishForm(
  timeoutMs = 15000,
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (
      findCreatorTab("上传图文") ||
      findTitleInput() ||
      findContentEditor() ||
      findFileInput()
    ) {
      return true;
    }
    await sleep(300);
  }
  return false;
}

/** 等待标题/正文编辑区（图片上传后常需跳转） */
export async function waitForEditFields(
  timeoutMs = 12000,
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (findTitleInput() || findContentEditor()) return true;
    await sleep(300);
  }
  return false;
}
