/** 扩展消息里不要传 ArrayBuffer：会被 JSON 成 {}，Blob 变成 15 字节的 "[object Object]"。 */

export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const chunk = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

export function base64ToBlob(b64: string, mime = "image/png"): Blob {
  const raw = base64ToBytes(b64);
  const copy = new Uint8Array(raw.byteLength);
  copy.set(raw);
  return new Blob([copy.buffer], { type: mime });
}
