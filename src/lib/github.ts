import type { DataSource, ExtensionConfig } from "@/types";
import { hasGitHubAccess, githubAccessDeniedMessage } from "./permissions";
import { getActiveSource, sourceCategory } from "./sources";

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

/** 已解析默认分支的仓库访问配置 */
export type ResolvedRepo = {
  githubToken: string;
  owner: string;
  repo: string;
  branch: string;
};

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

const defaultBranchCache = new Map<string, string>();

export async function fetchDefaultBranch(
  owner: string,
  repo: string,
  token: string,
): Promise<string> {
  const key = `${owner}/${repo}`;
  const cached = defaultBranchCache.get(key);
  if (cached) return cached;

  const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  const res = await fetch(url, { headers: authHeaders(token) });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new GitHubApiError(
      `读取仓库默认分支失败 (${res.status}): ${text || res.statusText}`,
      res.status,
    );
  }
  const data = (await res.json()) as { default_branch?: string };
  const branch = (data.default_branch || "main").trim() || "main";
  defaultBranchCache.set(key, branch);
  return branch;
}

export async function resolveRepo(source: DataSource): Promise<ResolvedRepo> {
  const owner = source.owner.trim();
  const repo = source.repo.trim();
  if (!owner || !repo) {
    throw new GitHubApiError("请先配置 owner / repo");
  }
  const branch = await fetchDefaultBranch(owner, repo, source.githubToken);
  return {
    githubToken: source.githubToken,
    owner,
    repo,
    branch,
  };
}

export function buildRawUrl(repo: ResolvedRepo, path: string): string {
  const clean = path.replace(/^\/+/, "");
  return `https://raw.githubusercontent.com/${repo.owner}/${repo.repo}/${repo.branch}/${clean}`;
}

export async function listDirectory(
  repo: ResolvedRepo,
  dirPath: string,
): Promise<{ entries: GitHubContentItem[]; missing: boolean }> {
  const encodedPath = dirPath
    .split("/")
    .filter(Boolean)
    .map(encodeURIComponent)
    .join("/");
  const url = `https://api.github.com/repos/${repo.owner}/${repo.repo}/contents/${encodedPath}?ref=${encodeURIComponent(repo.branch)}`;
  const res = await fetch(url, { headers: authHeaders(repo.githubToken) });

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
  repo: ResolvedRepo,
  path: string,
): Promise<T> {
  const raw = buildRawUrl(repo, path);
  const res = await fetch(raw, {
    headers: repo.githubToken
      ? { Authorization: `Bearer ${repo.githubToken}` }
      : undefined,
  });
  if (!res.ok) {
    throw new GitHubApiError(`读取 JSON 失败: ${path} (${res.status})`, res.status);
  }
  return (await res.json()) as T;
}

export async function fetchBlob(
  repo: ResolvedRepo,
  pathOrUrl: string,
): Promise<Blob> {
  const url = pathOrUrl.startsWith("http")
    ? pathOrUrl
    : buildRawUrl(repo, pathOrUrl);
  const res = await fetch(url, {
    headers: repo.githubToken
      ? { Authorization: `Bearer ${repo.githubToken}` }
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
  repo: ResolvedRepo,
  filePath: string,
): Promise<GitHubContentItem | null> {
  const encodedPath = filePath
    .split("/")
    .filter(Boolean)
    .map(encodeURIComponent)
    .join("/");
  const url = `https://api.github.com/repos/${repo.owner}/${repo.repo}/contents/${encodedPath}?ref=${encodeURIComponent(repo.branch)}`;
  const res = await fetch(url, { headers: authHeaders(repo.githubToken) });
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

/** 当前激活源对应的本地 category */
export function getCategoryList(config: ExtensionConfig): string[] {
  const src = getActiveSource(config);
  return [src ? sourceCategory(src.id) : "wechat_drafts"];
}

export async function assertGitHubReady(source: DataSource): Promise<void> {
  if (!source.owner?.trim() || !source.repo?.trim()) {
    throw new GitHubApiError("请先配置 owner / repo");
  }
  if (!(await hasGitHubAccess())) {
    throw new GitHubApiError(githubAccessDeniedMessage());
  }
}
