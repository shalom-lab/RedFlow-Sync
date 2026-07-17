/** 从原图生成侧栏用 JPEG 缩略图（OffscreenCanvas，可在 SW 运行） */
const THUMB_SIZE = 144;
const THUMB_QUALITY = 0.72;

export async function createThumbnailBlob(source: Blob): Promise<Blob> {
  const bitmap = await createImageBitmap(source);
  try {
    const canvas = new OffscreenCanvas(THUMB_SIZE, THUMB_SIZE);
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      throw new Error("OffscreenCanvas 2d 不可用");
    }

    const scale = Math.max(
      THUMB_SIZE / bitmap.width,
      THUMB_SIZE / bitmap.height,
    );
    const w = bitmap.width * scale;
    const h = bitmap.height * scale;
    const x = (THUMB_SIZE - w) / 2;
    const y = (THUMB_SIZE - h) / 2;
    ctx.clearRect(0, 0, THUMB_SIZE, THUMB_SIZE);
    ctx.drawImage(bitmap, x, y, w, h);

    return await canvas.convertToBlob({
      type: "image/jpeg",
      quality: THUMB_QUALITY,
    });
  } finally {
    bitmap.close();
  }
}
