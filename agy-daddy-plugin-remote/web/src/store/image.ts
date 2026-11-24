import type { ImageAttachment } from '../types';

const MAX_EDGE = 1600;
const MAX_BYTES = 400 * 1024;

function dataUrlByteSize(dataUrl: string): number {
  const idx = dataUrl.indexOf(',');
  if (idx < 0) return dataUrl.length;
  const b64 = dataUrl.slice(idx + 1);
  return Math.floor((b64.length * 3) / 4);
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('IMAGE_READ_FAILED'));
    reader.readAsDataURL(file);
  });
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('IMAGE_DECODE_FAILED'));
    img.src = src;
  });
}

export async function compressImageFile(file: File): Promise<ImageAttachment> {
  const rawUrl = await readAsDataUrl(file);
  try {
    const img = await loadImage(rawUrl);
    const scale = Math.min(1, MAX_EDGE / Math.max(img.width || 1, img.height || 1));
    const width = Math.max(1, Math.round((img.width || 1) * scale));
    const height = Math.max(1, Math.round((img.height || 1) * scale));

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      return {
        id: `img_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        name: file.name || 'image.jpg',
        dataUrl: rawUrl,
        mime: file.type || 'image/jpeg',
        bytes: dataUrlByteSize(rawUrl)
      };
    }

    ctx.drawImage(img, 0, 0, width, height);
    let dataUrl = canvas.toDataURL('image/jpeg', 0.82);
    for (const q of [0.7, 0.56, 0.44]) {
      if (dataUrlByteSize(dataUrl) <= MAX_BYTES) break;
      dataUrl = canvas.toDataURL('image/jpeg', q);
    }

    return {
      id: `img_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      name: file.name || 'image.jpg',
      dataUrl,
      mime: 'image/jpeg',
      bytes: dataUrlByteSize(dataUrl)
    };
  } catch {
    return {
      id: `img_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      name: file.name || 'image',
      dataUrl: rawUrl,
      mime: file.type || 'image/jpeg',
      bytes: dataUrlByteSize(rawUrl)
    };
  }
}
