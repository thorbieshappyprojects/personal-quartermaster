/**
 * Shrinks a photo in the browser before upload: longest side 2000 px, JPEG. This also turns
 * iPhone HEIC into JPEG (Safari decodes HEIC), and keeps uploads small on mobile data.
 * Falls back to the original file if the browser cannot decode it.
 */
export async function prepareUpload(file: File, max = 2000): Promise<{ blob: Blob; name: string }> {
  try {
    const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
    const w = Math.round(bitmap.width * scale);
    const h = Math.round(bitmap.height * scale);
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    canvas.getContext('2d')!.drawImage(bitmap, 0, 0, w, h);
    bitmap.close();
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.9));
    if (blob) return { blob, name: file.name.replace(/\.[^.]+$/, '') + '.jpg' };
  } catch {
    // fall through
  }
  return { blob: file, name: file.name };
}
