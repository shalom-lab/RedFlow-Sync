# Chrome Web Store — copy-paste fields

| Dashboard field | Value |
|-----------------|-------|
| **Title** | RedFlow-Sync |
| **Summary** (max 132 chars) | Sync InfoFlow GitHub notes & images into Xiaohongshu publish page — local cache, one-click fill. |
| **Category** | Productivity |
| **Language** | Chinese (Simplified) · English |

### Detailed description

RedFlow-Sync helps creators move structured posts from an InfoFlow Picker GitHub repo into the Xiaohongshu creator publish page — without re-downloading images every time.

**What it does**
- Reads JSON + images from your configured GitHub repository (InfoFlow layout)
- Incrementally syncs content into a local IndexedDB cache (background + manual sync)
- Injects a side panel on the Xiaohongshu image-note publish page
- One-click fill: title, body (prompt/content), and image into the web form
- Marks imported items so you do not repeat work

**Typical workflow**
1. Open the Options page, enter GitHub token / owner / repo / categories, and grant access to api.github.com and raw.githubusercontent.com when prompted
2. Sync to local cache (or wait for the scheduled incremental sync)
3. Open https://creator.xiaohongshu.com/publish/publish and use the side panel to import

**Privacy-minded permissions**
- `storage` — save configuration and import history on your device
- `alarms` — periodic incremental sync
- Optional host access only for GitHub API and raw content (requested when you save settings)
- Content script limited to the Xiaohongshu publish URL pattern

No account of ours is required. Your GitHub token stays in Chrome local storage on your machine.

---

## Image assets (overwrite placeholders after screenshot)

| Asset | Size | File |
|-------|------|------|
| Store icon | 128 × 128 | `icon128.png` |
| Screenshots (1–4) | 1280 × 800 | `screenshot-0N-1280x800.png` |
| Small promo tile | 440 × 280 | `promo-small-440x280.png` |
| Marquee promo tile | 1400 × 560 | `promo-marquee-1400x560.png` |

Design & capture: open `UI.html` at **100% zoom** → OS-screenshot each `.frame` → replace files above.

---

## Privacy practices (Dashboard)

**Single purpose**  
Help users sync their own InfoFlow GitHub content into the Xiaohongshu creator publish form.

**Permissions justification**
- **storage**: Store extension settings (token, repo, categories) and which `fileId`s were imported.
- **alarms**: Run periodic incremental sync so the local cache stays fresh.
- **optional host — https://api.github.com/***: List and read repository contents the user configured.
- **optional host — https://raw.githubusercontent.com/***: Download JSON and image blobs for local caching.
- **Content script (creator.xiaohongshu.com/publish/publish*)**: Inject the side panel and fill the publish form via DOM.

**Data usage**  
Data stays on the user’s device (Chrome storage + IndexedDB). Network calls go only to GitHub endpoints the user authorized, using the token they provided. We do not operate a backend that collects browsing history or Xiaohongshu credentials.

**Remote code**  
No remote code execution. All extension logic ships in the package.
