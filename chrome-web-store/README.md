# Chrome Web Store assets — RedFlow-Sync

1. Edit **`UI.html`** (each frame = one store image, exact pixel size)
2. Open **`UI.html`** in Chrome at **100%** zoom
3. OS-screenshot each `.frame` → overwrite the matching root PNG
4. Paste text from `copy-paste/en-US.md`

## Placeholder files (overwrite after capture)

| Slot | Size | File |
|------|------|------|
| Store icon | 128×128 | `icon128.png` |
| Screenshots | 1280×800 | `screenshot-01-1280x800.png` … |
| Small promo | 440×280 | `promo-small-440x280.png` |
| Marquee promo | 1400×560 | `promo-marquee-1400x560.png` |

Regenerate gray placeholders:

```bash
python chrome-web-store/scripts/make-placeholders.py
```
