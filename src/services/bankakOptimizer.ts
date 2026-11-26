/**
 * Bankak Receipt Client-side Image Optimization & Deduplication Engine
 * 
 * - Efficient Canvas / OffscreenCanvas compression (max 1600px, JPEG 0.85)
 * - Cryptographic SHA-256 image hashing for duplicate detection before upload
 * - Full telemetry: original size, compressed size, compression latency
 */

export interface CompressionResult {
  compressedBase64: string;
  compressedMimeType: string;
  originalSizeBytes: number;
  compressedSizeBytes: number;
  compressionDurationMs: number;
  width: number;
  height: number;
}

/**
 * Computes SHA-256 hex hash of original file or blob
 */
export async function calculateImageHash(file: File | Blob): Promise<string> {
  const buffer = await file.arrayBuffer();
  if (typeof crypto !== 'undefined' && crypto.subtle && typeof crypto.subtle.digest === 'function') {
    const digest = await crypto.subtle.digest('SHA-256', buffer);
    const hashArray = Array.from(new Uint8Array(digest));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  }
  // Lightweight fallback if crypto.subtle is restricted
  let hash = 0;
  const uint8 = new Uint8Array(buffer);
  for (let i = 0; i < uint8.length; i++) {
    hash = (hash * 31 + uint8[i]) | 0;
  }
  return 'fallback-' + Math.abs(hash).toString(16) + '-' + file.size;
}

/**
 * Optimizes receipt image for OCR analysis:
 * - Max dimension: 1600px
 * - Preserves aspect ratio
 * - JPEG quality 0.85
 * - Keeps original untouched for archiving
 */
export async function compressImageForOcr(file: File | Blob): Promise<CompressionResult> {
  const startTime = performance.now();
  const originalSizeBytes = file.size;
  const MAX_DIMENSION = 1600;
  const QUALITY = 0.85;

  // Modern path: OffscreenCanvas + createImageBitmap
  if (typeof OffscreenCanvas !== 'undefined' && typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(file);
      let targetWidth = bitmap.width;
      let targetHeight = bitmap.height;

      if (targetWidth > MAX_DIMENSION || targetHeight > MAX_DIMENSION) {
        const ratio = MAX_DIMENSION / Math.max(targetWidth, targetHeight);
        targetWidth = Math.round(targetWidth * ratio);
        targetHeight = Math.round(targetHeight * ratio);
      }

      const offscreen = new OffscreenCanvas(targetWidth, targetHeight);
      const ctx = offscreen.getContext('2d');
      if (ctx) {
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(bitmap, 0, 0, targetWidth, targetHeight);
        
        const blob = await offscreen.convertToBlob({ type: 'image/jpeg', quality: QUALITY });
        bitmap.close();

        const reader = new FileReader();
        const base64Promise = new Promise<string>((resolve, reject) => {
          reader.onload = () => resolve(reader.result as string);
          reader.onerror = reject;
        });
        reader.readAsDataURL(blob);
        const compressedBase64 = await base64Promise;

        const duration = Math.round(performance.now() - startTime);
        return {
          compressedBase64,
          compressedMimeType: 'image/jpeg',
          originalSizeBytes,
          compressedSizeBytes: blob.size,
          compressionDurationMs: duration,
          width: targetWidth,
          height: targetHeight,
        };
      }
    } catch (e) {
      console.warn('OffscreenCanvas compression fallback to HTMLCanvasElement:', e);
    }
  }

  // Universal DOM Canvas fallback
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = reject;
    reader.onload = (e) => {
      const dataUrl = e.target?.result as string;
      const img = new Image();
      img.onerror = reject;
      img.onload = () => {
        let targetWidth = img.naturalWidth || img.width;
        let targetHeight = img.naturalHeight || img.height;

        if (targetWidth > MAX_DIMENSION || targetHeight > MAX_DIMENSION) {
          const ratio = MAX_DIMENSION / Math.max(targetWidth, targetHeight);
          targetWidth = Math.round(targetWidth * ratio);
          targetHeight = Math.round(targetHeight * ratio);
        }

        const canvas = document.createElement('canvas');
        canvas.width = targetWidth;
        canvas.height = targetHeight;
        const ctx = canvas.getContext('2d');

        if (!ctx) {
          // If 2d context unavailable, return original
          const duration = Math.round(performance.now() - startTime);
          resolve({
            compressedBase64: dataUrl,
            compressedMimeType: file.type || 'image/jpeg',
            originalSizeBytes,
            compressedSizeBytes: originalSizeBytes,
            compressionDurationMs: duration,
            width: targetWidth,
            height: targetHeight,
          });
          return;
        }

        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(img, 0, 0, targetWidth, targetHeight);

        const compressedBase64 = canvas.toDataURL('image/jpeg', QUALITY);
        // Estimate byte size from base64
        const base64Content = compressedBase64.split(',')[1] || '';
        const compressedSizeBytes = Math.round((base64Content.length * 3) / 4);
        const duration = Math.round(performance.now() - startTime);

        resolve({
          compressedBase64,
          compressedMimeType: 'image/jpeg',
          originalSizeBytes,
          compressedSizeBytes,
          compressionDurationMs: duration,
          width: targetWidth,
          height: targetHeight,
        });
      };
      img.src = dataUrl;
    };
    reader.readAsDataURL(file);
  });
}
