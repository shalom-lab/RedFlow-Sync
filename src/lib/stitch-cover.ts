/**
 * 多图白缝平铺首图：合成图插到第 1 张，原图仍跟在后面。
 *
 * - 1 张：不拼
 * - 2 竖/混向：左右平铺，每格≈3:4（整图自然横版，避免瘦条裁切）
 * - 2 横：上下平铺，画布 3:4
 * - 3：上 1 下 2（品字），画布 3:4
 * - ≥4：取前 4 张 2×2，画布 3:4
 *
 * 一律平铺、不旋转、不叠放遮挡。
 */

const PORTRAIT_W = 1080;
const PORTRAIT_H = 1440;
/** 单格目标比例（竖海报） */
const CELL_W = 810;
const CELL_H = 1080;
const GAP_RATIO = 0.022;
const COVER_MIME = "image/jpeg";
const COVER_QUALITY = 0.92;
const MAX_UPLOAD_IMAGES = 9;

export type StitchCell = { x: number; y: number; w: number; h: number };

export type StitchLayout = {
  width: number;
  height: number;
  cells: StitchCell[];
};

function gapPx(basis: number): number {
  return Math.max(8, Math.round(basis * GAP_RATIO));
}

function isLandscape(width: number, height: number): boolean {
  return width > height;
}

/** 按张数与方向规划平铺格子 */
export function planStitchLayout(
  count: number,
  landscapeFlags: boolean[],
): StitchLayout | null {
  const n = Math.min(Math.max(count, 0), 4);
  if (n < 2) return null;

  if (n === 2) {
    const bothLandscape =
      landscapeFlags.slice(0, 2).filter(Boolean).length === 2;
    if (bothLandscape) {
      const g = gapPx(PORTRAIT_W);
      const cellH = Math.floor((PORTRAIT_H - g) / 2);
      return {
        width: PORTRAIT_W,
        height: PORTRAIT_H,
        cells: [
          { x: 0, y: 0, w: PORTRAIT_W, h: cellH },
          { x: 0, y: cellH + g, w: PORTRAIT_W, h: PORTRAIT_H - cellH - g },
        ],
      };
    }
    const g = gapPx(CELL_W);
    const width = CELL_W * 2 + g;
    return {
      width,
      height: CELL_H,
      cells: [
        { x: 0, y: 0, w: CELL_W, h: CELL_H },
        { x: CELL_W + g, y: 0, w: CELL_W, h: CELL_H },
      ],
    };
  }

  if (n === 3) {
    const g = gapPx(PORTRAIT_W);
    const rowH = Math.floor((PORTRAIT_H - g) / 2);
    const bottomH = PORTRAIT_H - rowH - g;
    const cellW = Math.floor((PORTRAIT_W - g) / 2);
    const rightW = PORTRAIT_W - cellW - g;
    return {
      width: PORTRAIT_W,
      height: PORTRAIT_H,
      cells: [
        { x: 0, y: 0, w: PORTRAIT_W, h: rowH },
        { x: 0, y: rowH + g, w: cellW, h: bottomH },
        { x: cellW + g, y: rowH + g, w: rightW, h: bottomH },
      ],
    };
  }

  // n === 4 → 2×2
  const g = gapPx(PORTRAIT_W);
  const cellW = Math.floor((PORTRAIT_W - g) / 2);
  const cellH = Math.floor((PORTRAIT_H - g) / 2);
  const rightW = PORTRAIT_W - cellW - g;
  const bottomH = PORTRAIT_H - cellH - g;
  return {
    width: PORTRAIT_W,
    height: PORTRAIT_H,
    cells: [
      { x: 0, y: 0, w: cellW, h: cellH },
      { x: cellW + g, y: 0, w: rightW, h: cellH },
      { x: 0, y: cellH + g, w: cellW, h: bottomH },
      { x: cellW + g, y: cellH + g, w: rightW, h: bottomH },
    ],
  };
}

function drawImageCover(
  ctx: OffscreenCanvasRenderingContext2D,
  bmp: ImageBitmap,
  cell: StitchCell,
): void {
  const br = bmp.width / bmp.height;
  const tr = cell.w / cell.h;
  let sx: number;
  let sy: number;
  let sw: number;
  let sh: number;
  if (br > tr) {
    sh = bmp.height;
    sw = bmp.height * tr;
    sx = (bmp.width - sw) / 2;
    sy = 0;
  } else {
    sw = bmp.width;
    sh = bmp.width / tr;
    sx = 0;
    sy = (bmp.height - sh) / 2;
  }
  ctx.drawImage(bmp, sx, sy, sw, sh, cell.x, cell.y, cell.w, cell.h);
}

/** 将多图拼成一张封面；不足 2 张返回 null */
export async function stitchCoverBlob(sources: Blob[]): Promise<Blob | null> {
  if (sources.length < 2) return null;

  const useCount = Math.min(sources.length, 4);
  const bitmaps: ImageBitmap[] = [];
  try {
    for (let i = 0; i < useCount; i++) {
      bitmaps.push(await createImageBitmap(sources[i]!));
    }

    const flags = bitmaps.map((b) => isLandscape(b.width, b.height));
    const layout = planStitchLayout(useCount, flags);
    if (!layout) return null;

    const canvas = new OffscreenCanvas(layout.width, layout.height);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("OffscreenCanvas 2d 不可用");

    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, layout.width, layout.height);

    for (let i = 0; i < layout.cells.length; i++) {
      drawImageCover(ctx, bitmaps[i]!, layout.cells[i]!);
    }

    return await canvas.convertToBlob({
      type: COVER_MIME,
      quality: COVER_QUALITY,
    });
  } finally {
    for (const b of bitmaps) b.close();
  }
}

/**
 * 拼贴首图 + 原图列表，总数压到小红书上限 9。
 * 拼贴失败时原样返回。
 */
export async function withStitchedCover(blobs: Blob[]): Promise<Blob[]> {
  if (blobs.length < 2) return blobs;
  try {
    const cover = await stitchCoverBlob(blobs);
    if (!cover || cover.size < 100) return blobs;
    return [cover, ...blobs].slice(0, MAX_UPLOAD_IMAGES);
  } catch {
    return blobs;
  }
}
