import {
  DEFAULT_DRAFTS_FILE,
  DEFAULT_IMAGES_PATH,
  DRAFTS_CATEGORY,
  formatRepoSlug,
  type DataSource,
  type ExtensionConfig,
} from "@/types";

export function newSourceId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `src_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function createDataSource(
  partial?: Partial<DataSource> & Pick<DataSource, "owner" | "repo">,
): DataSource {
  const owner = (partial?.owner || "shalom-lab").trim() || "shalom-lab";
  const repo = (partial?.repo || "InfoFlow").trim() || "InfoFlow";
  const name =
    (partial?.name || "").trim() || formatRepoSlug(owner, repo) || "数据源";
  return {
    id: partial?.id?.trim() || newSourceId(),
    name,
    githubToken: partial?.githubToken ?? "",
    owner,
    repo,
    basePath: (partial?.basePath || DEFAULT_DRAFTS_FILE).trim() || DEFAULT_DRAFTS_FILE,
    imagesPath:
      (partial?.imagesPath || DEFAULT_IMAGES_PATH).trim() || DEFAULT_IMAGES_PATH,
  };
}

/** IDB / 上传历史用的 category：`ds:{sourceId}` */
export function sourceCategory(sourceId: string): string {
  const id = sourceId.trim();
  if (!id) return DRAFTS_CATEGORY;
  return id.startsWith("ds:") ? id : `ds:${id}`;
}

export function sourceIdFromCategory(category: string): string | null {
  const c = category.trim();
  if (c.startsWith("ds:")) {
    const id = c.slice(3).trim();
    return id || null;
  }
  if (c === DRAFTS_CATEGORY || !c) return null;
  return null;
}

export function getActiveSource(cfg: ExtensionConfig): DataSource | null {
  if (!cfg.sources?.length) return null;
  const hit = cfg.sources.find((s) => s.id === cfg.activeSourceId);
  return hit ?? cfg.sources[0] ?? null;
}

export function getSourceById(
  cfg: ExtensionConfig,
  sourceId: string,
): DataSource | null {
  return cfg.sources.find((s) => s.id === sourceId) ?? null;
}

/** 按 category 反查数据源；旧 wechat_drafts 回落到当前激活源 */
export function getSourceByCategory(
  cfg: ExtensionConfig,
  category: string,
): DataSource | null {
  const sid = sourceIdFromCategory(category);
  if (sid) return getSourceById(cfg, sid) ?? getActiveSource(cfg);
  return getActiveSource(cfg);
}

export function activeSourceCategory(cfg: ExtensionConfig): string {
  const src = getActiveSource(cfg);
  return src ? sourceCategory(src.id) : DRAFTS_CATEGORY;
}

export function normalizeDataSource(raw: unknown): DataSource | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const owner = typeof r.owner === "string" ? r.owner.trim() : "";
  const repo = typeof r.repo === "string" ? r.repo.trim() : "";
  if (!owner || !repo) return null;
  return createDataSource({
    id: typeof r.id === "string" ? r.id : undefined,
    name: typeof r.name === "string" ? r.name : undefined,
    githubToken: typeof r.githubToken === "string" ? r.githubToken : "",
    owner,
    repo,
    basePath: typeof r.basePath === "string" ? r.basePath : undefined,
    imagesPath: typeof r.imagesPath === "string" ? r.imagesPath : undefined,
  });
}
