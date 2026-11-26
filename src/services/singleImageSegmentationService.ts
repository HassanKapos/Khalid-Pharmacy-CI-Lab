/**
 * Single Image Segmentation & Multi-Medicine OCR Service
 * Phase 3.6-B — Khalid Pharmacy (com.khalidpharmacy.app)
 * Phase 3.6-B.1 — Segmentation Safety Refinement
 *
 * Provides capabilities for taking/uploading a single high-resolution image containing multiple
 * medicine packages, detecting bounding boxes (automatic proposal + manual interactive adjustment),
 * cropping isolated regions with safe padding (restricted between adjacent medicines),
 * accurate coordinate mapping between display UI and original image,
 * running independent OCR/parsing on each region, and feeding the results into the Batch Capture session.
 */

import { parseMedicineText, matchMedicineText, MedicineMatch } from './medicineTextParser.ts';
import { medicineTextRecognitionService, NativeMedicineOcrResult } from './medicineTextRecognitionService.ts';
import { batchCaptureService } from './batchCaptureService.ts';
import { barcodeScannerService } from './barcodeScannerService.ts';
import { mlKitPocService } from './mlKitPocService.ts';
import { staticImageBarcodeService } from './staticImageBarcodeService.ts';

export interface BoundingBox {
  id: string;
  x: number;      // Pixel X on original image
  y: number;      // Pixel Y on original image
  width: number;  // Pixel width on original image
  height: number; // Pixel height on original image
  label?: string;
  confidence?: number;
}

export interface DisplayMappingOptions {
  originalWidth: number;   // naturalWidth of original image
  originalHeight: number;  // naturalHeight of original image
  displayWidth: number;    // rendered width of canvas / container in UI
  displayHeight: number;   // rendered height of canvas / container in UI
  offsetX?: number;        // letterbox offset X if object-fit contain
  offsetY?: number;        // letterbox offset Y if object-fit contain
}

export interface SegmentedRegionResult {
  box: BoundingBox;
  croppedImageDataUrl: string;
  barcodeDetected?: string;
  barcodeFormat?: string;
  ocrResult: NativeMedicineOcrResult | null;
  parsedMatches: MedicineMatch[];
  status: 'SUCCESS' | 'PARTIAL' | 'FAILED';
  errorMessage?: string;
}

export interface SingleImageMultiOCRResult {
  sessionId: string;
  originalImageDimensions: { width: number; height: number };
  regions: SegmentedRegionResult[];
  processedCount: number;
  successCount: number;
}

export class SingleImageSegmentationService {
  /**
   * Automatic bounding box detection proposal algorithm.
   * Performs edge/contrast analysis and 2D connected-component grouping on the source image
   * to propose non-overlapping package regions without relying on a fixed grid.
   * Returns an empty list if no distinct foreground packages are detected so the user can draw regions manually.
   */
  public async proposeBoundingBoxes(
    imageElement: HTMLImageElement | HTMLCanvasElement
  ): Promise<{ width: number; height: number; boxes: BoundingBox[] }> {
    const width = Number((imageElement as HTMLImageElement).naturalWidth || imageElement.width);
    const height = Number((imageElement as HTMLImageElement).naturalHeight || imageElement.height);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
      throw new Error('أبعاد الصورة غير صالحة؛ تعذر اقتراح مناطق الالتقاط');
    }
    const boxes: BoundingBox[] = [];
    if (typeof document !== 'undefined') {
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = typeof canvas.getContext === 'function' ? canvas.getContext('2d') : null;
      if (ctx) {
      ctx.drawImage(imageElement, 0, 0, width, height);
      try {
        const imageData = ctx.getImageData(0, 0, width, height);
        const data = imageData.data;
        if (data && data.length >= width * height * 4) {
          const detected = this.detectConnectedPackageRegions(data, width, height);
          boxes.push(...detected);
        }
      } catch (err) {
        console.warn('Canvas image analysis error:', err);
      }
    }
    }

    return { width, height, boxes };
  }

  /**
   * Validates pharmacist-supplied regions before any crop/OCR work.
   * Strongly overlapping or duplicate regions are rejected to avoid assigning
   * the same package text to multiple medicine records.
   */
  public validateBoundingBoxes(boxes: BoundingBox[], width: number, height: number): void {
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
      throw new Error('أبعاد الصورة الأصلية غير صالحة');
    }
    if (!Array.isArray(boxes) || boxes.length === 0) {
      throw new Error('يجب تحديد منطقة دواء واحدة على الأقل يدوياً');
    }

    const ids = new Set<string>();
    for (let i = 0; i < boxes.length; i++) {
      const box = boxes[i];
      if (!box || typeof box.id !== 'string' || !box.id.trim() || ids.has(box.id)) {
        throw new Error('معرّفات مناطق الأدوية مفقودة أو مكررة');
      }
      ids.add(box.id);
      if (
        ![box.x, box.y, box.width, box.height].every(Number.isFinite) ||
        box.x < 0 || box.y < 0 || box.width <= 0 || box.height <= 0 ||
        box.x + box.width > width || box.y + box.height > height
      ) {
        throw new Error(`حدود منطقة الدواء غير صالحة أو خارج الصورة: ${box.id}`);
      }

      for (let j = 0; j < i; j++) {
        const other = boxes[j];
        const intersectionWidth = Math.max(0, Math.min(box.x + box.width, other.x + other.width) - Math.max(box.x, other.x));
        const intersectionHeight = Math.max(0, Math.min(box.y + box.height, other.y + other.height) - Math.max(box.y, other.y));
        const intersectionArea = intersectionWidth * intersectionHeight;
        const smallerArea = Math.min(box.width * box.height, other.width * other.height);
        if (intersectionArea === smallerArea || intersectionArea > smallerArea * 0.5) {
          throw new Error(`منطقتا دواء متطابقتان أو متداخلتان بدرجة غير آمنة: ${other.id} / ${box.id}`);
        }
      }
    }
  }

  private detectConnectedPackageRegions(
    data: Uint8ClampedArray,
    width: number,
    height: number
  ): BoundingBox[] {
    if (width < 24 || height < 24) return [];

    // Downsample into small spatial blocks (~120-160 blocks on longest edge)
    const blockSize = Math.max(4, Math.floor(Math.max(width, height) / 140));
    const cols = Math.floor(width / blockSize);
    const rows = Math.floor(height / blockSize);
    if (cols < 3 || rows < 3) return [];

    const totalCells = cols * rows;
    const cellMeanLum = new Float32Array(totalCells);
    const cellMeanChroma = new Float32Array(totalCells);
    const cellContrast = new Float32Array(totalCells);
    const cellEdgeEnergy = new Float32Array(totalCells);

    // Sample pixels inside each block to measure luminance, chroma, contrast, and gradient edges
    const sampleStep = Math.max(1, Math.floor(blockSize / 4));
    for (let r = 0; r < rows; r++) {
      const y0 = r * blockSize;
      const y1 = Math.min(height, y0 + blockSize);
      for (let c = 0; c < cols; c++) {
        const x0 = c * blockSize;
        const x1 = Math.min(width, x0 + blockSize);
        let sumLum = 0;
        let sumChroma = 0;
        let minLum = 255;
        let maxLum = 0;
        let edgeSum = 0;
        let edgeSamples = 0;
        let count = 0;

        for (let y = y0; y < y1; y += sampleStep) {
          let prevLum = -1;
          for (let x = x0; x < x1; x += sampleStep) {
            const idx = (y * width + x) * 4;
            const red = data[idx];
            const green = data[idx + 1];
            const blue = data[idx + 2];
            const lum = 0.299 * red + 0.587 * green + 0.114 * blue;
            const maxC = Math.max(red, green, blue);
            const minC = Math.min(red, green, blue);
            sumLum += lum;
            sumChroma += (maxC - minC);
            if (lum < minLum) minLum = lum;
            if (lum > maxLum) maxLum = lum;
            if (prevLum >= 0) {
              edgeSum += Math.abs(lum - prevLum);
              edgeSamples++;
            }
            prevLum = lum;
            count++;
          }
        }

        const cellIdx = r * cols + c;
        cellMeanLum[cellIdx] = count > 0 ? sumLum / count : 0;
        cellMeanChroma[cellIdx] = count > 0 ? sumChroma / count : 0;
        cellContrast[cellIdx] = count > 0 ? maxLum - minLum : 0;
        cellEdgeEnergy[cellIdx] = edgeSamples > 0 ? edgeSum / edgeSamples : 0;
      }
    }

    // Estimate background luminance and chroma from perimeter cells
    const borderLums: number[] = [];
    const borderChromas: number[] = [];
    for (let c = 0; c < cols; c++) {
      borderLums.push(cellMeanLum[c], cellMeanLum[(rows - 1) * cols + c]);
      borderChromas.push(cellMeanChroma[c], cellMeanChroma[(rows - 1) * cols + c]);
    }
    for (let r = 1; r < rows - 1; r++) {
      borderLums.push(cellMeanLum[r * cols], cellMeanLum[r * cols + (cols - 1)]);
      borderChromas.push(cellMeanChroma[r * cols], cellMeanChroma[r * cols + (cols - 1)]);
    }
    borderLums.sort((a, b) => a - b);
    borderChromas.sort((a, b) => a - b);
    const bgLum = borderLums.length > 0 ? borderLums[Math.floor(borderLums.length / 2)] : 128;
    const bgChroma = borderChromas.length > 0 ? borderChromas[Math.floor(borderChromas.length / 2)] : 0;

    // Foreground mask: printed typography edges, contrast, chroma shift, or luminance delta vs border
    const rawActive = new Uint8Array(totalCells);
    let rawActiveCount = 0;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const i = r * cols + c;
        const bgDiff = Math.abs(cellMeanLum[i] - bgLum);
        const chromaDiff = Math.abs(cellMeanChroma[i] - bgChroma);
        const neighborDiff = Math.max(
          c > 0 ? Math.abs(cellMeanLum[i] - cellMeanLum[i - 1]) : 0,
          c + 1 < cols ? Math.abs(cellMeanLum[i] - cellMeanLum[i + 1]) : 0,
          r > 0 ? Math.abs(cellMeanLum[i] - cellMeanLum[i - cols]) : 0,
          r + 1 < rows ? Math.abs(cellMeanLum[i] - cellMeanLum[i + cols]) : 0
        );
        if (
          cellContrast[i] >= 18 ||
          cellEdgeEnergy[i] >= 11 ||
          neighborDiff >= 16 ||
          bgDiff >= 24 ||
          chromaDiff >= 20
        ) {
          rawActive[i] = 1;
          rawActiveCount++;
        }
      }
    }

    // Blank/uniform canvas or wholly uniform image yields zero regions
    if (rawActiveCount === 0) return [];

    // Light hole-filling inside package boxes (fill isolated inactive cells surrounded by >= 5 active neighbors)
    const active = new Uint8Array(rawActive);
    for (let r = 1; r < rows - 1; r++) {
      for (let c = 1; c < cols - 1; c++) {
        const i = r * cols + c;
        if (rawActive[i]) continue;
        let neighbors = 0;
        for (let dr = -1; dr <= 1; dr++) {
          for (let dc = -1; dc <= 1; dc++) {
            if (dr === 0 && dc === 0) continue;
            if (rawActive[(r + dr) * cols + (c + dc)]) neighbors++;
          }
        }
        if (neighbors >= 5) {
          active[i] = 1;
        }
      }
    }

    // Connected-component extraction (8-connected)
    const visited = new Uint8Array(totalCells);
    interface RawRegion {
      minC: number;
      maxC: number;
      minR: number;
      maxR: number;
      cells: number;
      avgContrast: number;
    }
    const rawRegions: RawRegion[] = [];
    const queue = new Int32Array(totalCells);

    for (let startR = 0; startR < rows; startR++) {
      for (let startC = 0; startC < cols; startC++) {
        const startIdx = startR * cols + startC;
        if (!active[startIdx] || visited[startIdx]) continue;

        let head = 0;
        let tail = 0;
        queue[tail++] = startIdx;
        visited[startIdx] = 1;

        let minC = startC;
        let maxC = startC;
        let minR = startR;
        let maxR = startR;
        let cells = 0;
        let contrastSum = 0;

        while (head < tail) {
          const curr = queue[head++];
          const cr = Math.floor(curr / cols);
          const cc = curr % cols;
          cells++;
          contrastSum += cellContrast[curr];

          if (cc < minC) minC = cc;
          if (cc > maxC) maxC = cc;
          if (cr < minR) minR = cr;
          if (cr > maxR) maxR = cr;

          for (let dr = -1; dr <= 1; dr++) {
            const nr = cr + dr;
            if (nr < 0 || nr >= rows) continue;
            for (let dc = -1; dc <= 1; dc++) {
              if (dr === 0 && dc === 0) continue;
              const nc = cc + dc;
              if (nc < 0 || nc >= cols) continue;
              const nIdx = nr * cols + nc;
              if (active[nIdx] && !visited[nIdx]) {
                visited[nIdx] = 1;
                queue[tail++] = nIdx;
              }
            }
          }
        }

        const regionW = (maxC - minC + 1) * blockSize;
        const regionH = (maxR - minR + 1) * blockSize;
        const regionArea = regionW * regionH;
        const imageArea = width * height;

        // Ignore tiny speckles and full-frame noise blobs
        if (
          regionW >= width * 0.06 &&
          regionH >= height * 0.06 &&
          regionArea >= imageArea * 0.008 &&
          !(regionW >= width * 0.94 && regionH >= height * 0.94)
        ) {
          rawRegions.push({
            minC,
            maxC,
            minR,
            maxR,
            cells,
            avgContrast: cells > 0 ? contrastSum / cells : 0
          });
        }
      }
    }

    // Convert to pixel rectangles and absorb fragments nested inside an outer box
    const candidateRects = rawRegions.map((reg) => {
      const x = Math.max(0, reg.minC * blockSize);
      const y = Math.max(0, reg.minR * blockSize);
      const x2 = Math.min(width, (reg.maxC + 1) * blockSize);
      const y2 = Math.min(height, (reg.maxR + 1) * blockSize);
      return {
        x,
        y,
        width: Math.max(1, x2 - x),
        height: Math.max(1, y2 - y),
        confidence: Math.min(0.95, Math.max(0.55, 0.55 + reg.avgContrast / 120))
      };
    });

    const filteredRects = candidateRects.filter((rect, idx) => {
      const rectArea = rect.width * rect.height;
      return !candidateRects.some((other, otherIdx) => {
        if (idx === otherIdx) return false;
        const otherArea = other.width * other.height;
        if (otherArea <= rectArea) return false;
        const interLeft = Math.max(rect.x, other.x);
        const interTop = Math.max(rect.y, other.y);
        const interRight = Math.min(rect.x + rect.width, other.x + other.width);
        const interBottom = Math.min(rect.y + rect.height, other.y + other.height);
        if (interRight <= interLeft || interBottom <= interTop) return false;
        const interArea = (interRight - interLeft) * (interBottom - interTop);
        return interArea / rectArea >= 0.75;
      });
    });

    // Sort deterministically top-to-bottom, left-to-right
    filteredRects.sort((a, b) => {
      const rowDiff = Math.abs(a.y - b.y);
      if (rowDiff > Math.min(a.height, b.height) * 0.4) {
        return a.y - b.y;
      }
      return a.x - b.x;
    });

    const baseTs = Date.now();
    return filteredRects.slice(0, 10).map((rect, index) => ({
      id: `box-${baseTs}-${index + 1}`,
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
      label: `عبوة ${index + 1}`,
      confidence: rect.confidence
    }));
  }

  /**
   * Splits one bounding box cleanly into two non-overlapping halves along the chosen axis.
   * Useful when two boxes are physically touching side-by-side or stacked in a photo.
   */
  public splitBoundingBox(
    box: BoundingBox,
    axis: 'vertical' | 'horizontal' = 'vertical',
    nextIndexBase: number = 1
  ): [BoundingBox, BoundingBox] {
    if (!box || box.width < 20 || box.height < 20) {
      throw new Error('حجم المربع أصغر من الحد الأدنى للتقسيم');
    }
    const ts = Date.now();
    if (axis === 'vertical') {
      const halfW = Math.floor(box.width / 2);
      return [
        {
          ...box,
          width: halfW,
          label: box.label || `عبوة ${nextIndexBase}`
        },
        {
          id: `box-split-${ts}-b`,
          x: box.x + halfW,
          y: box.y,
          width: box.width - halfW,
          height: box.height,
          label: `عبوة ${nextIndexBase + 1}`,
          confidence: box.confidence
        }
      ];
    }
    const halfH = Math.floor(box.height / 2);
    return [
      {
        ...box,
        height: halfH,
        label: box.label || `عبوة ${nextIndexBase}`
      },
      {
        id: `box-split-${ts}-b`,
        x: box.x,
        y: box.y + halfH,
        width: box.width,
        height: box.height - halfH,
        label: `عبوة ${nextIndexBase + 1}`,
        confidence: box.confidence
      }
    ];
  }

  /**
   * Calculates safe crop bounds for a bounding box with target padding,
   * ensuring:
   * 1. Target 10% padding is applied where possible.
   * 2. Crop bounds stay strictly inside the original image dimensions [0..srcWidth, 0..srcHeight].
   * 3. Crop bounds do not enter the original unpadded Bounding Box of any neighboring medicine box.
   * 4. Original box rectangle is preserved intact without shrinking.
   *
   * If allBoxes is omitted, this is an explicit single-region operation.
   * Multi-region callers must pass the complete approved region list; an explicit
   * empty list is rejected by validateBoundingBoxes rather than silently trusted.
   */
  public calculateSafeCropBounds(
    box: BoundingBox,
    srcWidth: number,
    srcHeight: number,
    allBoxes?: BoundingBox[],
    paddingPercent: number = 0.10
  ): { x: number; y: number; width: number; height: number } {
    const validatedBoxes = allBoxes === undefined ? [box] : allBoxes;
    this.validateBoundingBoxes(validatedBoxes, srcWidth, srcHeight);
    const targetBox = validatedBoxes.find((candidate) => candidate.id === box.id);
    if (!targetBox) {
      throw new Error('منطقة القص غير موجودة ضمن قائمة المناطق المعتمدة');
    }
    if (!Number.isFinite(paddingPercent) || paddingPercent < 0 || paddingPercent > 0.5) {
      throw new Error('نسبة هامش القص غير صالحة');
    }
    // Use the canonical validated object, never coordinates supplied alongside its ID.
    const padX = Math.floor(targetBox.width * paddingPercent);
    const padY = Math.floor(targetBox.height * paddingPercent);

    const A_left = targetBox.x;
    const A_right = targetBox.x + targetBox.width;
    const A_top = targetBox.y;
    const A_bottom = targetBox.y + targetBox.height;

    let cropLeft = A_left - padX;
    let cropRight = A_right + padX;
    let cropTop = A_top - padY;
    let cropBottom = A_bottom + padY;

    // 1. Clamp to original image bounds
    cropLeft = Math.max(0, cropLeft);
    cropRight = Math.min(srcWidth, cropRight);
    cropTop = Math.max(0, cropTop);
    cropBottom = Math.min(srcHeight, cropBottom);

    // 2. Restrict padding against neighbor boxes
    for (const other of validatedBoxes) {
      if (!other || other.id === box.id) continue;

      const B_left = other.x;
      const B_right = other.x + other.width;
      const B_top = other.y;
      const B_bottom = other.y + other.height;

      // Check vertical overlap with other box
      const vOverlap = Math.max(cropTop, B_top) < Math.min(cropBottom, B_bottom);
      if (vOverlap) {
        // If other box is to the left of box A, clamp cropLeft so it does not enter box B
        if (B_left < A_left && cropLeft < B_right) {
          cropLeft = Math.max(cropLeft, B_right);
        }
        // If other box is to the right of box A, clamp cropRight so it does not enter box B
        if (B_right > A_right && cropRight > B_left) {
          cropRight = Math.min(cropRight, B_left);
        }
      }

      // Check horizontal overlap with other box
      const hOverlap = Math.max(cropLeft, B_left) < Math.min(cropRight, B_right);
      if (hOverlap) {
        // If other box is above box A, clamp cropTop so it does not enter box B
        if (B_top < A_top && cropTop < B_bottom) {
          cropTop = Math.max(cropTop, B_bottom);
        }
        // If other box is below box A, clamp cropBottom so it does not enter box B
        if (B_bottom > A_bottom && cropBottom > B_top) {
          cropBottom = Math.min(cropBottom, B_top);
        }
      }
    }

    // 3. Guarantee original box is not shrunk
    cropLeft = Math.min(cropLeft, A_left);
    cropRight = Math.max(cropRight, A_right);
    cropTop = Math.min(cropTop, A_top);
    cropBottom = Math.max(cropBottom, A_bottom);

    // Final sanity clamp to image bounds
    cropLeft = Math.max(0, Math.min(srcWidth - 1, cropLeft));
    cropTop = Math.max(0, Math.min(srcHeight - 1, cropTop));
    cropRight = Math.max(cropLeft + 1, Math.min(srcWidth, cropRight));
    cropBottom = Math.max(cropTop + 1, Math.min(srcHeight, cropBottom));

    return {
      x: Math.round(cropLeft),
      y: Math.round(cropTop),
      width: Math.round(cropRight - cropLeft),
      height: Math.round(cropBottom - cropTop)
    };
  }

  /**
   * Crops a specified bounding box region from the original image with safe padding (10% target padding).
   * Restricts padding dynamically when adjacent medicine bounding boxes are near each other.
   * Does NOT alter or shrink the original box coordinates.
   * If allBoxes is omitted, only this single region is in scope. Multi-region
   * callers must pass the complete approved list; an explicit empty list is invalid.
   */
  public cropRegionWithPadding(
    sourceImage: HTMLImageElement | HTMLCanvasElement,
    box: BoundingBox,
    paddingPercent: number = 0.10,
    allBoxes?: BoundingBox[]
  ): string {
    const srcWidth = Number((sourceImage as HTMLImageElement).naturalWidth || sourceImage.width);
    const srcHeight = Number((sourceImage as HTMLImageElement).naturalHeight || sourceImage.height);
    const validatedBoxes = allBoxes === undefined ? [box] : allBoxes;
    this.validateBoundingBoxes(validatedBoxes, srcWidth, srcHeight);
    const targetBox = validatedBoxes.find((candidate) => candidate.id === box.id);
    if (!targetBox) {
      throw new Error('منطقة القص غير موجودة ضمن قائمة المناطق المعتمدة');
    }

    const safeCrop = this.calculateSafeCropBounds(targetBox, srcWidth, srcHeight, validatedBoxes, paddingPercent);

    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, safeCrop.width);
    canvas.height = Math.max(1, safeCrop.height);

    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.drawImage(sourceImage, safeCrop.x, safeCrop.y, safeCrop.width, safeCrop.height, 0, 0, safeCrop.width, safeCrop.height);
    }

    return canvas.toDataURL('image/jpeg', 0.85);
  }

  /**
   * Maps a bounding box from displayed UI canvas/container coordinates to original image pixel coordinates.
   * Handles scale differences, naturalWidth/Height, CSS scaling, and letterboxing offsets.
   */
  public mapDisplayToOriginalBox(
    displayBox: { x: number; y: number; width: number; height: number },
    mapping: DisplayMappingOptions
  ): { x: number; y: number; width: number; height: number } {
    const { originalWidth, originalHeight, displayWidth, displayHeight, offsetX = 0, offsetY = 0 } = mapping;

    const scaleX = displayWidth > 0 ? originalWidth / displayWidth : 1;
    const scaleY = displayHeight > 0 ? originalHeight / displayHeight : 1;

    const relX = displayBox.x - offsetX;
    const relY = displayBox.y - offsetY;

    let x = Math.round(relX * scaleX);
    let y = Math.round(relY * scaleY);
    let w = Math.round(displayBox.width * scaleX);
    let h = Math.round(displayBox.height * scaleY);

    // Enforce positive minimum size
    w = Math.max(1, w);
    h = Math.max(1, h);

    // Clamp x, y to strictly within original image boundaries
    x = Math.max(0, Math.min(originalWidth - 1, x));
    y = Math.max(0, Math.min(originalHeight - 1, y));

    if (x + w > originalWidth) {
      w = Math.max(1, originalWidth - x);
    }
    if (y + h > originalHeight) {
      h = Math.max(1, originalHeight - y);
    }

    return { x, y, width: w, height: h };
  }

  /**
   * Maps a bounding box from original image pixel coordinates to displayed UI canvas/container coordinates.
   * Handles scale differences, naturalWidth/Height, CSS scaling, and letterboxing offsets.
   */
  public mapOriginalToDisplayBox(
    originalBox: { x: number; y: number; width: number; height: number },
    mapping: DisplayMappingOptions
  ): { x: number; y: number; width: number; height: number } {
    const { originalWidth, originalHeight, displayWidth, displayHeight, offsetX = 0, offsetY = 0 } = mapping;

    const scaleX = originalWidth > 0 ? displayWidth / originalWidth : 1;
    const scaleY = originalHeight > 0 ? displayHeight / originalHeight : 1;

    const x = Math.round(originalBox.x * scaleX) + offsetX;
    const y = Math.round(originalBox.y * scaleY) + offsetY;
    const w = Math.round(originalBox.width * scaleX);
    const h = Math.round(originalBox.height * scaleY);

    return {
      x: Math.max(0, x),
      y: Math.max(0, y),
      width: Math.max(1, w),
      height: Math.max(1, h)
    };
  }

  /**
   * Processes a single image with multiple bounding boxes:
   * 1. Checks Camera ownership lock.
   * 2. For each bounding box, crops the sub-image region with safe padding restricted against neighbors.
   * 3. Runs independent OCR / Medicine parsing per region.
   * 4. Integrates the parsed items into a Batch Session in `batchCaptureService`.
   * 5. Enforces safety invariants: `safeToAutoSelect: false`, zero auto cart additions.
   */
  public async processSingleImageMultiRegion(
    sourceImage: HTMLImageElement | HTMLCanvasElement,
    boxes: BoundingBox[],
    catalog: any[] = [],
    options?: { originalImageDataUrl?: string; onRegionDone?: (done: number, total: number) => void }
  ): Promise<SingleImageMultiOCRResult> {
    // Exclude both camera owners: web ZXing and Android native ML Kit.
    const webScanState = (barcodeScannerService as any)?.isScanning;
    const webScanning = typeof webScanState === 'function'
      ? Boolean(webScanState.call(barcodeScannerService))
      : Boolean(webScanState || (typeof barcodeScannerService?.getDiagnostics === 'function' && barcodeScannerService.getDiagnostics()?.isScanning));
    const nativeScanState = (mlKitPocService as any)?.isScanning;
    const nativeScanning = typeof nativeScanState === 'function'
      ? Boolean(nativeScanState.call(mlKitPocService))
      : Boolean(nativeScanState);
    if (webScanning || nativeScanning) {
      throw new Error('الكاميرا قيد الاستخدام بواسطة ماسح الباركود (Native أو Web). يرجى إيقاف الماسح أولاً.');
    }

    const srcWidth = Number((sourceImage as HTMLImageElement).naturalWidth || sourceImage.width);
    const srcHeight = Number((sourceImage as HTMLImageElement).naturalHeight || sourceImage.height);
    this.validateBoundingBoxes(boxes, srcWidth, srcHeight);

    // Do not silently discard a previous capture session when opening single-image OCR.
    if (batchCaptureService.isBusy() || batchCaptureService.getItems().length > 0) {
      throw new Error('توجد جلسة التقاط أخرى غير منتهية. احفظ/ألغِ الجلسة الحالية قبل بدء معالجة صورة متعددة الأدوية.');
    }

    // Start a new batch capture session for this multi-medicine single image
    const session = batchCaptureService.startBatchSession('UNIFIED_IMAGE');
    let originalImageId: string | undefined;
    if (options?.originalImageDataUrl && options.originalImageDataUrl.startsWith('data:image/')) {
      const origRecord = batchCaptureService.registerOriginalImage({
        dataUrl: options.originalImageDataUrl,
        width: srcWidth,
        height: srcHeight
      });
      originalImageId = origRecord.id;
    }

    const regionResults: SegmentedRegionResult[] = [];
    let successCount = 0;

    for (let i = 0; i < boxes.length; i++) {
      if (batchCaptureService.getSessionId() !== session.sessionId) break;
      const box = boxes[i];
      const regionStart = typeof performance !== 'undefined' ? performance.now() : Date.now();
      const croppedImageDataUrl = this.cropRegionWithPadding(sourceImage, box, 0.10, boxes);

      try {
        // 1. Barcode-First extraction on cropped region
        const barcodeResult = await staticImageBarcodeService.decodeFromImage(croppedImageDataUrl).catch(() => null);
        const barcodeDetected = barcodeResult?.barcode || undefined;
        const barcodeFormat = barcodeResult?.format || undefined;

        // 2. Independent OCR on cropped region
        let ocrText = '';
        let ocrSuccess = false;
        let ocrErrorMessage = undefined;

        try {
          if (medicineTextRecognitionService.isAndroidNative()) {
            const base64 = croppedImageDataUrl.replace(/^data:image\/\w+;base64,/, '');
            const nativeRes = await medicineTextRecognitionService.recognizeStillImage(base64);
            ocrText = nativeRes.text;
            ocrSuccess = true;
          } else if (typeof atob !== 'undefined') {
            const arr = croppedImageDataUrl.split(',');
            const mime = arr[0].match(/:(.*?);/)?.[1] || 'image/jpeg';
            const bstr = atob(arr[1] || '');
            let n = bstr.length;
            const u8arr = new Uint8Array(n);
            while (n--) {
              u8arr[n] = bstr.charCodeAt(n);
            }
            const blob = new Blob([u8arr], { type: mime });
            const webRes = await medicineTextRecognitionService.recognizeWebImage(blob);
            ocrText = webRes.text;
            ocrSuccess = true;
          }
        } catch (ocrErr: any) {
          ocrErrorMessage = ocrErr?.message;
        }

        const ocrResult: NativeMedicineOcrResult = {
          text: ocrText,
          lines: ocrText ? ocrText.split(/\r?\n/).map((l) => l.trim()).filter(Boolean) : [],
          blocks: []
        };

        // Fallback check for barcode digits printed cleanly in OCR text
        const textBarcodeMatch = !barcodeDetected && ocrText
          ? ocrText.match(/\b(621\d{10}|\d{13}|\d{12}|\d{8})\b/)
          : null;
        const effectiveBarcode = barcodeDetected || (textBarcodeMatch ? textBarcodeMatch[1] : undefined);

        let parsedMatches: MedicineMatch[] = [];
        if ((ocrSuccess && ocrText && ocrText.trim().length > 0) || effectiveBarcode) {
          const profile = parseMedicineText(ocrText);
          parsedMatches = matchMedicineText(profile, catalog, effectiveBarcode);
          // Invariant: Never allow safeToAutoSelect = true automatically
          for (const m of parsedMatches) {
            m.safeToAutoSelect = false;
          }
        }

        const topMatch = parsedMatches[0];
        const status: 'SUCCESS' | 'PARTIAL' | 'FAILED' =
          (ocrSuccess || Boolean(effectiveBarcode)) && topMatch && topMatch.status === 'verified'
            ? 'SUCCESS'
            : (ocrSuccess || Boolean(effectiveBarcode))
            ? 'PARTIAL'
            : 'FAILED';

        if (status === 'SUCCESS' || status === 'PARTIAL') {
          successCount++;
        }

        const regionResult: SegmentedRegionResult = {
          box,
          croppedImageDataUrl,
          barcodeDetected,
          barcodeFormat,
          ocrResult,
          parsedMatches,
          status,
          errorMessage: ocrErrorMessage
        };

        if (batchCaptureService.getSessionId() !== session.sessionId) {
          return {
            sessionId: session.sessionId,
            originalImageDimensions: { width: srcWidth, height: srcHeight },
            regions: regionResults,
            processedCount: regionResults.length,
            successCount
          };
        }
        regionResults.push(regionResult);

        // Add to batch capture session with strict region binding and full candidate list
        const classified = batchCaptureService.classifyMatch(parsedMatches, ocrText, effectiveBarcode);
        const durationMs = Math.round((typeof performance !== 'undefined' ? performance.now() : Date.now()) - regionStart);
        batchCaptureService.addItemToSession(session.sessionId, {
          imageDataUrl: croppedImageDataUrl,
          ocrResult: {
            success: ocrSuccess || Boolean(barcodeDetected),
            text: ocrText,
            extractedText: ocrText,
            errorMessage: ocrErrorMessage,
            barcodeDetected,
            barcodeFormat
          },
          candidates: parsedMatches.slice(0, 6),
          parsedResult: classified.selected || topMatch ? {
            matchedProduct: classified.selected || topMatch?.medicine || null,
            confidence: topMatch?.confidence || 0,
            classification: classified.classification,
            matchReason: [...classified.reasons, ...classified.conflicts].join(' • '),
            safeToAutoSelect: false
          } : null,
          detectedBoundingBox: box,
          barcodeDetected,
          barcodeFormat,
          originalImageId,
          captureMode: 'UNIFIED_IMAGE',
          processingDurationMs: durationMs
        });
      } catch (err: any) {
        console.error(`Error processing region box ${box.id}:`, err);
        const regionResult: SegmentedRegionResult = {
          box,
          croppedImageDataUrl,
          ocrResult: null,
          parsedMatches: [],
          status: 'FAILED',
          errorMessage: err.message || 'فشلت معالجة صورة العبوة'
        };
        if (batchCaptureService.getSessionId() !== session.sessionId) {
          return {
            sessionId: session.sessionId,
            originalImageDimensions: { width: srcWidth, height: srcHeight },
            regions: regionResults,
            processedCount: regionResults.length,
            successCount
          };
        }
        regionResults.push(regionResult);

        batchCaptureService.addItemToSession(session.sessionId, {
          imageDataUrl: croppedImageDataUrl,
          ocrResult: {
            text: '',
            extractedText: '',
            confidence: 0,
            lines: [],
            success: false,
            errorMessage: err.message || 'فشل محرك OCR'
          },
          parsedResult: {
            matchedProduct: null,
            confidence: 0,
            classification: 'UNKNOWN MEDICINE',
            matchReason: 'فشل التعرف الضوئي على النص',
            safeToAutoSelect: false
          },
          detectedBoundingBox: box,
          originalImageId,
          captureMode: 'UNIFIED_IMAGE'
        });
      }

      if (options?.onRegionDone) {
        try { options.onRegionDone(i + 1, boxes.length); } catch { /* ignore */ }
      }
    }

    return {
      sessionId: session.sessionId,
      originalImageDimensions: { width: srcWidth, height: srcHeight },
      regions: regionResults,
      processedCount: regionResults.length,
      successCount
    };
  }
}

export const singleImageSegmentationService = new SingleImageSegmentationService();
