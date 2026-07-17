/**
 * Chrome Web Store 友好权限策略：
 * - 安装时不声明宽泛 host_permissions
 * - GitHub 域名放入 optional_host_permissions，用户手势下按需授权
 * - 小红书仅靠 content_scripts.matches 注入，不再额外要整站 host
 */

/** 仅访问列表目录与 raw 图片所需的最窄域名 */
export const GITHUB_HOST_PERMISSIONS = [
  "https://api.github.com/*",
  "https://raw.githubusercontent.com/*",
] as const;

export async function hasGitHubAccess(): Promise<boolean> {
  try {
    return await chrome.permissions.contains({
      origins: [...GITHUB_HOST_PERMISSIONS],
    });
  } catch {
    return false;
  }
}

/**
 * 仅在扩展页（Options / Popup）的用户手势中调用。
 * 注意：不要先 await contains，再 request——会打断用户手势导致 request 失败。
 * 已授权时 request 会立刻返回 true 且不弹窗。
 */
export async function requestGitHubAccess(): Promise<boolean> {
  try {
    return await chrome.permissions.request({
      origins: [...GITHUB_HOST_PERMISSIONS],
    });
  } catch (err) {
    console.warn("[RedFlow] permissions.request 失败", err);
    return false;
  }
}

/** @deprecated 易打断手势；UI 请用 requestGitHubAccess，后台只用 hasGitHubAccess */
export async function ensureGitHubAccess(): Promise<boolean> {
  return requestGitHubAccess();
}

export function githubAccessDeniedMessage(): string {
  return "尚未授权访问 GitHub。请打开扩展 Options 页保存配置并在弹窗中允许 api.github.com / raw.githubusercontent.com。";
}
