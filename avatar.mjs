// 頭像只儲存在此瀏覽器；匯入時重繪圖片，移除 EXIF 等檔案附帶資訊。
const KEY = 'fxweb.avatar.v1.';
const TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const MAX_FILE = 5 * 1024 * 1024;
const MAX_PIXELS = 40_000_000;
const SIZE = 256;
const identityKey = (mode, username) => KEY + (mode === 'server' && username ? 'user:' + username.toLowerCase() : 'guest');

export function getAvatar(mode, username) {
  try { const value = localStorage.getItem(identityKey(mode, username)); return value?.startsWith('data:image/webp;base64,') || value?.startsWith('data:image/png;base64,') ? value : null; }
  catch { return null; }
}

export function removeAvatar(mode, username) {
  try { localStorage.removeItem(identityKey(mode, username)); return true; } catch { return false; }
}

export async function saveAvatar(file, mode, username) {
  if (!TYPES.has(file?.type)) throw new Error('請選擇 JPG、PNG 或 WebP 圖片。');
  if (!(file.size > 0 && file.size <= MAX_FILE)) throw new Error('頭像檔案不得超過 5 MB。');
  const url = URL.createObjectURL(file);
  const image = new Image();
  try {
    image.decoding = 'async'; image.src = url;
    await image.decode();
    const width = image.naturalWidth, height = image.naturalHeight;
    if (!width || !height || width * height > MAX_PIXELS) throw new Error('圖片尺寸過大，請選擇較小的照片。');
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = SIZE;
    const ctx = canvas.getContext('2d'); if (!ctx) throw new Error('目前瀏覽器無法處理圖片。');
    ctx.fillStyle = '#e1f4e9'; ctx.fillRect(0, 0, SIZE, SIZE);
    const crop = Math.min(width, height);
    ctx.drawImage(image, (width - crop) / 2, (height - crop) / 2, crop, crop, 0, 0, SIZE, SIZE);
    let data = canvas.toDataURL('image/webp', .8);
    if (!data.startsWith('data:image/webp')) data = canvas.toDataURL('image/png');
    if (data.length > 400_000) throw new Error('圖片處理後仍太大，請換一張圖片。');
    try { localStorage.setItem(identityKey(mode, username), data); }
    catch { throw new Error('本機儲存空間不足，無法保存頭像。'); }
    return data;
  } catch (e) { if (e.name === 'EncodingError') throw new Error('圖片讀取失敗，請換一張圖片。'); throw e; }
  finally { URL.revokeObjectURL(url); }
}

export function avatarImage(data) {
  if (!data) return Promise.resolve(null);
  return new Promise(resolve => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => resolve(null);
    image.src = data;
  });
}
