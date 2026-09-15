import type { ExtensionConfig } from "@/types";
import { DRAFTS_CATEGORY } from "@/types";
import { hasGitHubAccess, githubAccessDeniedMessage } from "./permissions";

export class GitHubApiError extends Error {
  constructor(
    message: string,
    public status?: number,
  ) {
    super(message);
    this.name = "GitHubApiError";
  }
}

export interface GitHubContentItem {
  name: string;
  path: string;
  type: "file" | "dir";
  download_url: string | null;
  sha: string;
}

function authHeaders(token: string): HeadersInit {
  const headers: HeadersInit = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

export function joinPath(...parts: string[]): string {
  return parts
    .map((p) => p.replace(/^\/+|\/+$/g, ""))
    .filter(Boolean)
    .join("/");
}

export function buildRawUrl(
  config: Pick<ExtensionConfig, "owner" | "repo" | "branch">,
  path: string,
): string {
  const clean = path.replace(/^\/+/, "");
  return `https://raw.githubusercontent.com/${config.owner}/${config.repo}/${config.branch}/${clean}`;
}

export async function listDirectory(
  config: ExtensionConfig,
  dirPath: string,
): Promise<{ entries: GitHubContentItem[]; missing: boolean }> {
  const encodedPath = dirPath
    .split("/")
    .filter(Boolean)
    .map(encodeURIComponent)
    .join("/");
  const url = `https://api.github.com/repos/${config.owner}/${config.repo}/contents/${encodedPath}?ref=${encodeURIComponent(config.branch)}`;
  const res = await fetch(url, { headers: authHeaders(config.githubToken) });

  if (res.status === 404) {
    return { entries: [], missing: true };
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new GitHubApiError(
      `GitHub API 失败 (${res.status}): ${text || res.statusText}`,
      res.status,
    );
  }

  const data = (await res.json()) as GitHubContentItem[] | GitHubContentItem;
  if (!Array.isArray(data)) {
    throw new GitHubApiError("期望目录列表，但返回了单个文件");
  }
  return { entries: data, missing: false };
}

export async function fetchJsonFile<T>(
  config: ExtensionConfig,
  path: string,
): Promise<T> {
  const raw = buildRawUrl(config, path);
  const res = await fetch(raw, {
    headers: config.githubToken
      ? { Authorization: `Bearer ${config.githubToken}` }
      : undefined,
  });
  if (!res.ok) {
    throw new GitHubApiError(`读取 JSON 失败: ${path} (${res.status})`, res.status);
  }
  return (await res.json()) as T;
}

export async function fetchBlob(
  config: ExtensionConfig,
  pathOrUrl: string,
): Promise<Blob> {
  const url = pathOrUrl.startsWith("http")
    ? pathOrUrl
    : buildRawUrl(config, pathOrUrl);
  const res = await fetch(url, {
    headers: config.githubToken
      ? { Authorization: `Bearer ${config.githubToken}` }
      : undefined,
    cache: "no-cache",
  });
  if (!res.ok) {
    throw new GitHubApiError(`下载失败: ${url} (${res.status})`, res.status);
  }
  const blob = await res.blob();
  if (!blob.size) throw new GitHubApiError(`空文件: ${url}`);
  return blob;
}

/** 读取单个文件元信息；不存在返回 null */
export async function getFileMeta(
  config: ExtensionConfig,
  filePath: string,
): Promise<GitHubContentItem | null> {
  const encodedPath = filePath
    .split("/")
    .filter(Boolean)
    .map(encodeURIComponent)
    .join("/");
  const url = `https://api.github.com/repos/${config.owner}/${config.repo}/contents/${encodedPath}?ref=${encodeURIComponent(config.branch)}`;
  const res = await fetch(url, { headers: authHeaders(config.githubToken) });
  if (res.status === 404) return null;
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new GitHubApiError(
      `GitHub API 失败 (${res.status}): ${text || res.statusText}`,
      res.status,
    );
  }
  const data = (await res.json()) as GitHubContentItem | GitHubContentItem[];
  if (Array.isArray(data) || data.type !== "file") return null;
  return data;
}

/** 当前数据源为单一草稿索引，侧栏固定一个分类 */
export function getCategoryList(_config: ExtensionConfig): string[] {
  return [DRAFTS_CATEGORY];
}

export async function assertGitHubReady(
  config: ExtensionConfig,
): Promise<void> {
  if (!config.owner || !config.repo) {
    throw new GitHubApiError("请先配置 owner / repo");
  }
  if (!(await hasGitHubAccess())) {
    throw new GitHubApiError(githubAccessDeniedMessage());
  }
}
