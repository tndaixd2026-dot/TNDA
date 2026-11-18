// 上傳照片前先在瀏覽器縮小、轉成 JPEG（65 吋螢幕 1600px 寬就很清楚，檔案約 150～400 KB）
export async function imageToDataUrl(file: File, maxW = 1600, maxH = 1200, quality = 0.82): Promise<string> {
  if (!/^image\//.test(file.type)) throw new Error('請選擇圖片檔（JPG、PNG）');
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await img.decode();
    const scale = Math.min(1, maxW / img.naturalWidth, maxH / img.naturalHeight);
    const w = Math.max(1, Math.round(img.naturalWidth * scale));
    const h = Math.max(1, Math.round(img.naturalHeight * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('瀏覽器無法處理圖片');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);
    let out = canvas.toDataURL('image/jpeg', quality);
    // 太大就再壓一次
    if (out.length > 2_500_000) out = canvas.toDataURL('image/jpeg', 0.65);
    return out;
  } finally {
    URL.revokeObjectURL(url);
  }
}
