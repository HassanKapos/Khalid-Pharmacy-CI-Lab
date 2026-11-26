export interface WebMedicineOcrResult {
  text: string;
  confidence: number;
}

export interface OcrReadabilityScore {
  score: number;
  wordCount: number;
  dosageCount: number;
  pharmaFormCount: number;
  fragmentCount: number;
  noiseCount: number;
  anomalousCount: number;
  weirdSymbolCount: number;
  isGarbled: boolean;
}

export type TesseractWorker = {
  recognize(image: Blob | File): Promise<{ data?: { text?: string; confidence?: number } }>;
  setParameters?: (params: Record<string, string>) => Promise<unknown>;
  terminate(): Promise<void>;
};

export type TesseractModule = {
  createWorker: (
    languages: string,
    oem: number,
    options: Record<string, unknown>
  ) => Promise<TesseractWorker>;
};

export interface WebMedicineOcrServiceOptions {
  moduleLoader?: (moduleUrl: string) => Promise<unknown>;
  assetEnsurer?: () => Promise<void>;
  assetReadinessChecker?: () => Promise<boolean>;
}

const OCR_ROOT = '/tesseract';
const OCR_CACHE_NAME = 'khalid-pharmacy-ocr-v1';
const REQUIRED_ASSETS = [
  `${OCR_ROOT}/tesseract.esm.min.js`,
  `${OCR_ROOT}/worker.min.js`,
  `${OCR_ROOT}/core/tesseract-core.wasm.js`,
  `${OCR_ROOT}/core/tesseract-core-simd.wasm.js`,
  `${OCR_ROOT}/core/tesseract-core-lstm.wasm.js`,
  `${OCR_ROOT}/core/tesseract-core-simd-lstm.wasm.js`,
  `${OCR_ROOT}/core/tesseract-core.wasm`,
  `${OCR_ROOT}/core/tesseract-core-simd.wasm`,
  `${OCR_ROOT}/core/tesseract-core-lstm.wasm`,
  `${OCR_ROOT}/core/tesseract-core-simd-lstm.wasm`,
  `${OCR_ROOT}/lang/eng.traineddata.gz`
];

const VALID_SHORT_PHARMA_TOKENS = new Set([
  'mg', 'ml', 'iu', 'gm', 'xr', 'sr', 'er', 'cr', 'mr', 'dr', 'iv', 'im',
  'xl', 'ds', 'hs', 'od', 'bd', 'la', 'bp', 'ip'
]);

const PHARMA_FORM_REGEX = /\b(?:tablets?|capsules?|caplets?|syrup|suspension|drops?|cream|gel|ointment|injection|vials?|ampoules?|sachets?|coated|sugar-coated|film-coated|extended|sustained|release|oral|solution|inhaler|spray|suppositories?)\b/gi;

/**
 * Scores OCR output to distinguish readable medicine labels (e.g. "Bralix 5 mg/2.5 mg", "Piramyl 4 mg Tablets")
 * from noisy glyph gibberish or sideways OCR hallucinations (e.g. ">nge1 © sie|del OE Buy apuidsul JAwelld").
 */
export function scoreOcrTextReadability(text: string, confidence: number = 0): OcrReadabilityScore {
  const cleaned = String(text || '').replace(/\s+/g, ' ').trim();
  if (!cleaned) {
    return {
      score: 0,
      wordCount: 0,
      dosageCount: 0,
      pharmaFormCount: 0,
      fragmentCount: 0,
      noiseCount: 0,
      anomalousCount: 0,
      weirdSymbolCount: 0,
      isGarbled: true
    };
  }

  const dosageMatches = cleaned.match(/\d+(?:[.,]\d+)?\s*(?:\/\s*\d+(?:[.,]\d+)?\s*)?(?:mg|mcg|g|ml|iu|gm|%)/gi) || [];
  const pharmaMatches = cleaned.match(PHARMA_FORM_REGEX) || [];
  const weirdSymbols = cleaned.match(/[><©|~^_{}[\]\\§°`]/g) || [];
  const tokens = cleaned.split(/\s+/).filter(Boolean);

  let wordCount = 0;
  let fragmentCount = 0;
  let noiseCount = 0;
  let anomalousCount = 0;

  for (const token of tokens) {
    // Strip benign leading/trailing punctuation; ®/™ at end of brand name is normal
    const stripped = token.replace(/^[^A-Za-z0-9]+|[®™.,:;!?)]+$/g, '').replace(/[^A-Za-z0-9%/-]+$/g, '');
    if (!stripped) {
      noiseCount++;
      continue;
    }

    // Internal weird characters like "sie|del" or mixed random letters+digits like "nge1" (excluding dosages/hours)
    if (/[|<>©~^_{}[\]\\]/.test(stripped)) {
      anomalousCount++;
      noiseCount++;
      continue;
    }
    if (/[A-Za-z]+\d+|\d+[A-Za-z]+/.test(stripped) &&
        !/^\d+(?:[.,/]\d+)*(?:mg|mcg|g|ml|iu|gm|%|h|hr|hrs)?$/i.test(stripped)) {
      anomalousCount++;
      noiseCount++;
      continue;
    }

    // Two+ uppercase letters immediately followed by two+ lowercase (e.g. "JAwelld") usually indicates rotated OCR noise
    if (/^[A-Z]{2,}[a-z]{2,}$/.test(stripped)) {
      anomalousCount++;
    }

    const alphaRuns = stripped.match(/[A-Za-z]{3,}/g) || [];
    if (alphaRuns.length > 0) {
      wordCount += alphaRuns.length;
    } else if (/^\d+(?:[.,/]\d+)*$/.test(stripped)) {
      if (stripped.length >= 4) {
        wordCount++;
      } else {
        noiseCount++;
      }
    } else if (/^[A-Za-z]{1,2}$/.test(stripped)) {
      if (!VALID_SHORT_PHARMA_TOKENS.has(stripped.toLowerCase())) {
        fragmentCount++;
      }
    } else {
      noiseCount++;
    }

    const strayPunct = token.match(/[|;~^_{}[\]\\"`'<>©]/g);
    if (strayPunct) {
      noiseCount += strayPunct.length;
    }
  }

  const dosageCount = dosageMatches.length;
  const pharmaFormCount = pharmaMatches.length;
  const weirdSymbolCount = weirdSymbols.length;
  const clampedConf = Math.max(0, Math.min(100, Number(confidence || 0)));

  const score = Math.round(
    wordCount * 16 +
    dosageCount * 26 +
    pharmaFormCount * 22 +
    clampedConf * 0.55 -
    fragmentCount * 6 -
    noiseCount * 4 -
    anomalousCount * 12 -
    weirdSymbolCount * 6
  );

  const isGarbled =
    wordCount === 0 ||
    ((anomalousCount >= 1 || weirdSymbolCount >= 2) && dosageCount === 0 && pharmaFormCount === 0 && score < 55) ||
    (fragmentCount + noiseCount > wordCount * 2 && dosageCount === 0) ||
    score < 15;

  return {
    score,
    wordCount,
    dosageCount,
    pharmaFormCount,
    fragmentCount,
    noiseCount,
    anomalousCount,
    weirdSymbolCount,
    isGarbled
  };
}

/**
 * Extracts the cleanest readable medicine name suggestion from OCR lines,
 * returning '' instead of proposing symbol/gibberish strings like "nge1 ©".
 */
export function extractCleanMedicineNameSuggestion(rawText: string): string {
  const cleanedText = String(rawText || '').trim();
  if (!cleanedText) return '';

  const overall = scoreOcrTextReadability(cleanedText, 70);
  if (overall.isGarbled) return '';

  const lines = cleanedText
    .split(/\r?\n/)
    .map((line) =>
      line
        .replace(/^[>\s<|•*~©®™.:;,-]+/, '')
        .replace(/[\s<|•*~©®™;]+$/g, '')
        .replace(/\s+/g, ' ')
        .trim()
    )
    .filter((line) => /[A-Za-z]{3,}/.test(line));

  if (lines.length === 0) return '';

  let bestLine = '';
  let bestScore = -Infinity;
  for (const line of lines) {
    const lineEval = scoreOcrTextReadability(line, 75);
    if (lineEval.isGarbled) continue;
    if (lineEval.score > bestScore) {
      bestScore = lineEval.score;
      bestLine = line;
    }
  }

  return bestLine;
}

interface PreparedOcrImages {
  primaryBlob: Blob;
  buildAdaptiveBinaryBlob: () => Promise<Blob | null>;
  buildRotatedBlob: (angle: 90 | 180 | 270) => Promise<Blob | null>;
}

function canvasToPngBlob(canvas: HTMLCanvasElement): Promise<Blob | null> {
  return new Promise((resolve) => {
    try {
      canvas.toBlob((blob) => resolve(blob), 'image/png');
    } catch {
      resolve(null);
    }
  });
}

async function decodeImageSource(blob: Blob): Promise<{
  source: CanvasImageSource;
  width: number;
  height: number;
  cleanup: () => void;
} | null> {
  if (typeof document === 'undefined' || typeof Image === 'undefined') return null;

  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' });
      if (bitmap.width > 0 && bitmap.height > 0) {
        return {
          source: bitmap,
          width: bitmap.width,
          height: bitmap.height,
          cleanup: () => {
            try { bitmap.close(); } catch { /* ignore */ }
          }
        };
      }
      bitmap.close();
    } catch {
      // Fall back to HTMLImageElement below
    }
  }

  if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') return null;

  const objectUrl = URL.createObjectURL(blob);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('decode-failed'));
      el.src = objectUrl;
    });
    const width = img.naturalWidth || img.width || 0;
    const height = img.naturalHeight || img.height || 0;
    if (width <= 0 || height <= 0) {
      URL.revokeObjectURL(objectUrl);
      return null;
    }
    return {
      source: img,
      width,
      height,
      cleanup: () => {
        try { URL.revokeObjectURL(objectUrl); } catch { /* ignore */ }
      }
    };
  } catch {
    try { URL.revokeObjectURL(objectUrl); } catch { /* ignore */ }
    return null;
  }
}

/**
 * Enhances raw mobile photos for Tesseract LSTM:
 * 1. Respects EXIF camera rotation via createImageBitmap({ imageOrientation: 'from-image' }).
 * 2. Scales small crops up to ~1400px and caps giant photos at 1800px.
 * 3. Adds a 24px white quiet-zone border.
 * 4. Applies 2%..98% histogram contrast stretching + mild 3x3 sharpening.
 * 5. Provides a lazy Bradley-Roth integral-image adaptive binary variant for uneven lighting/glare.
 */
async function preprocessImageForOcr(image: Blob | File): Promise<PreparedOcrImages | null> {
  if (typeof document === 'undefined' || !image.type || !image.type.startsWith('image/')) {
    return null;
  }

  const decoded = await decodeImageSource(image);
  if (!decoded) return null;

  try {
    const { source, width: srcW, height: srcH } = decoded;
    const maxDim = Math.max(srcW, srcH);
    let scale = 1;
    if (maxDim < 1200) {
      scale = Math.min(3, 1400 / maxDim);
    } else if (maxDim > 1800) {
      scale = 1800 / maxDim;
    }

    const innerW = Math.max(1, Math.round(srcW * scale));
    const innerH = Math.max(1, Math.round(srcH * scale));
    const pad = 24;
    const canvasW = innerW + pad * 2;
    const canvasH = innerH + pad * 2;

    const canvas = document.createElement('canvas');
    canvas.width = canvasW;
    canvas.height = canvasH;
    const ctx = typeof canvas.getContext === 'function'
      ? canvas.getContext('2d', { willReadFrequently: true }) || canvas.getContext('2d')
      : null;
    if (!ctx) return null;

    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvasW, canvasH);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(source, pad, pad, innerW, innerH);

    const imgData = ctx.getImageData(0, 0, canvasW, canvasH);
    const data = imgData.data;
    const totalPixels = canvasW * canvasH;
    const lum = new Uint8Array(totalPixels);
    const hist = new Uint32Array(256);

    for (let y = pad; y < pad + innerH; y++) {
      for (let x = pad; x < pad + innerW; x++) {
        const p = y * canvasW + x;
        const i = p * 4;
        const v = Math.max(0, Math.min(255, Math.round(0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2])));
        lum[p] = v;
        hist[v]++;
      }
    }

    const innerPixels = innerW * innerH;
    const lowTarget = Math.floor(innerPixels * 0.02);
    const highTarget = Math.floor(innerPixels * 0.98);
    let cumulative = 0;
    let pLow = 0;
    let pHigh = 255;
    let foundLow = false;

    for (let v = 0; v < 256; v++) {
      cumulative += hist[v];
      if (!foundLow && cumulative >= lowTarget) {
        pLow = v;
        foundLow = true;
      }
      if (cumulative >= highTarget) {
        pHigh = v;
        break;
      }
    }

    const span = Math.max(12, pHigh - pLow);
    const stretched = new Uint8Array(totalPixels);
    stretched.fill(255);

    for (let y = pad; y < pad + innerH; y++) {
      for (let x = pad; x < pad + innerW; x++) {
        const p = y * canvasW + x;
        const norm = (lum[p] - pLow) / span;
        const clamped = Math.max(0, Math.min(1, norm));
        stretched[p] = Math.round(clamped * 255);
      }
    }

    const sharpened = new Uint8Array(totalPixels);
    sharpened.fill(255);
    for (let y = pad; y < pad + innerH; y++) {
      for (let x = pad; x < pad + innerW; x++) {
        const p = y * canvasW + x;
        const neighborAvg = (
          stretched[p - 1] +
          stretched[p + 1] +
          stretched[p - canvasW] +
          stretched[p + canvasW]
        ) * 0.25;
        const sharpVal = Math.max(0, Math.min(255, Math.round(stretched[p] * 1.45 - neighborAvg * 0.45)));
        sharpened[p] = sharpVal;
        const i = p * 4;
        data[i] = sharpVal;
        data[i + 1] = sharpVal;
        data[i + 2] = sharpVal;
        data[i + 3] = 255;
      }
    }

    ctx.putImageData(imgData, 0, 0);
    const primaryBlob = await canvasToPngBlob(canvas);
    if (!primaryBlob) return null;

    const buildAdaptiveBinaryBlob = async (): Promise<Blob | null> => {
      const binCanvas = document.createElement('canvas');
      binCanvas.width = canvasW;
      binCanvas.height = canvasH;
      const binCtx = binCanvas.getContext('2d');
      if (!binCtx) return null;

      const integral = new Int32Array(totalPixels);
      for (let y = 0; y < canvasH; y++) {
        let rowSum = 0;
        for (let x = 0; x < canvasW; x++) {
          const idx = y * canvasW + x;
          rowSum += sharpened[idx];
          integral[idx] = (y > 0 ? integral[idx - canvasW] : 0) + rowSum;
        }
      }

      const radius = Math.max(12, Math.min(48, Math.round(Math.min(innerW, innerH) / 32)));
      const outData = binCtx.createImageData(canvasW, canvasH);
      const out = outData.data;
      out.fill(255);

      for (let y = pad; y < pad + innerH; y++) {
        const y1 = Math.max(0, y - radius);
        const y2 = Math.min(canvasH - 1, y + radius);
        for (let x = pad; x < pad + innerW; x++) {
          const x1 = Math.max(0, x - radius);
          const x2 = Math.min(canvasW - 1, x + radius);
          const count = (x2 - x1 + 1) * (y2 - y1 + 1);
          const sum =
            integral[y2 * canvasW + x2] -
            (y1 > 0 ? integral[(y1 - 1) * canvasW + x2] : 0) -
            (x1 > 0 ? integral[y2 * canvasW + (x1 - 1)] : 0) +
            (y1 > 0 && x1 > 0 ? integral[(y1 - 1) * canvasW + (x1 - 1)] : 0);

          const p = y * canvasW + x;
          const mean = sum / count;
          const val = sharpened[p];
          const isInk = val < mean * 0.88 && (mean - val) > 9;
          const pixel = isInk ? 0 : 255;
          const i = p * 4;
          out[i] = pixel;
          out[i + 1] = pixel;
          out[i + 2] = pixel;
          out[i + 3] = 255;
        }
      }

      binCtx.putImageData(outData, 0, 0);
      return canvasToPngBlob(binCanvas);
    };

    const buildRotatedBlob = async (angle: 90 | 180 | 270): Promise<Blob | null> => {
      const rotCanvas = document.createElement('canvas');
      if (angle === 180) {
        rotCanvas.width = canvasW;
        rotCanvas.height = canvasH;
      } else {
        rotCanvas.width = canvasH;
        rotCanvas.height = canvasW;
      }
      const rotCtx = rotCanvas.getContext('2d');
      if (!rotCtx) return null;

      rotCtx.fillStyle = '#ffffff';
      rotCtx.fillRect(0, 0, rotCanvas.width, rotCanvas.height);
      rotCtx.translate(rotCanvas.width / 2, rotCanvas.height / 2);
      rotCtx.rotate((angle * Math.PI) / 180);
      rotCtx.drawImage(canvas, -canvasW / 2, -canvasH / 2);
      return canvasToPngBlob(rotCanvas);
    };

    return { primaryBlob, buildAdaptiveBinaryBlob, buildRotatedBlob };
  } catch {
    return null;
  } finally {
    decoded.cleanup();
  }
}

/**
 * Resolves the Tesseract API from either a direct ESM export or a Rollup/CJS default wrapper.
 * Prevents "tesseract.createWorker is not a function" when loading tesseract.esm.min.js.
 */
export function resolveTesseractApi(mod: unknown): TesseractModule {
  if (mod && typeof mod === 'object') {
    const direct = mod as { createWorker?: unknown };
    if (typeof direct.createWorker === 'function') {
      return direct as TesseractModule;
    }
    const wrapped = (mod as { default?: { createWorker?: unknown } }).default;
    if (wrapped && typeof wrapped.createWorker === 'function') {
      return wrapped as TesseractModule;
    }
  }
  throw new Error('تعذر تهيئة محرك التعرف الضوئي المحلي (createWorker غير متاح). أعد المحاولة بعد تحديث الصفحة.');
}

/** Browser-only, same-origin OCR. No CDN fallback is permitted. */
export class WebMedicineTextRecognitionService {
  private workerPromise: Promise<TesseractWorker> | null = null;
  private ensureReadyPromise: Promise<boolean> | null = null;
  private recognizeQueue: Promise<unknown> = Promise.resolve();
  private readonly options: WebMedicineOcrServiceOptions;

  constructor(options: WebMedicineOcrServiceOptions = {}) {
    this.options = options;
  }

  public async isReady(): Promise<boolean> {
    if (this.options.assetReadinessChecker) {
      return this.options.assetReadinessChecker();
    }
    if (typeof window === 'undefined' || typeof Worker === 'undefined' || typeof caches === 'undefined') return false;
    try {
      // Check Cache Storage directly: this remains reliable in airplane mode and
      // does not issue HEAD requests that cannot match cached GET responses.
      const cache = await caches.open(OCR_CACHE_NAME);
      const responses = await Promise.all(
        REQUIRED_ASSETS.map((url) => cache.match(url).then((hit) => hit || caches.match(url)))
      );
      return responses.every((response) => !!response && response.ok && new URL(response.url).origin === window.location.origin);
    } catch {
      return false;
    }
  }

  /**
   * Ensures all required local WASM/worker/language assets are cached in CacheStorage.
   * When already cached, returns true offline without network calls.
   * When online and uncached (e.g. cold boot before SW finishes precaching), fetches and caches same-origin /tesseract/* assets.
   */
  public async ensureReady(): Promise<boolean> {
    if (await this.isReady()) return true;
    if (this.options.assetEnsurer) {
      try {
        await this.options.assetEnsurer();
        return true;
      } catch {
        return false;
      }
    }
    if (typeof window === 'undefined' || typeof Worker === 'undefined' || typeof caches === 'undefined') {
      return false;
    }
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      return false;
    }
    if (!this.ensureReadyPromise) {
      this.ensureReadyPromise = (async () => {
        try {
          const cache = await caches.open(OCR_CACHE_NAME);
          for (const url of REQUIRED_ASSETS) {
            const existing = (await cache.match(url)) || (await caches.match(url));
            if (existing && existing.ok && new URL(existing.url).origin === window.location.origin) {
              continue;
            }
            const response = await fetch(url, { cache: 'no-cache' });
            if (!response.ok || new URL(response.url, window.location.origin).origin !== window.location.origin) {
              throw new Error(`تعذر تحميل ملف التعرف المحلي: ${url}`);
            }
            await cache.put(url, response.clone());
          }
          return await this.isReady();
        } catch {
          return false;
        } finally {
          this.ensureReadyPromise = null;
        }
      })();
    }
    return this.ensureReadyPromise;
  }

  private async ensureAssetsReadyOrThrow(): Promise<void> {
    if (this.options.assetEnsurer) {
      await this.options.assetEnsurer();
      return;
    }
    if (await this.isReady()) return;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      throw new Error('التطبيق غير متصل بالإنترنت وملفات التعرف الضوئي المحلية غير مكتملة في الذاكرة بعد. اتصل بالإنترنت لإكمال التثبيت ثم أعد المحاولة.');
    }
    const ready = await this.ensureReady();
    if (!ready) {
      throw new Error('تعذر تحميل نموذج التعرف الضوئي المحلي. يمكنك إعادة المحاولة دون فقدان الصورة.');
    }
  }

  private async getWorker(): Promise<TesseractWorker> {
    if (!this.workerPromise) {
      this.workerPromise = (async () => {
        await this.ensureAssetsReadyOrThrow();

        // Keep the module URL same-origin and bypass Vite's static import analysis.
        const moduleUrl = `${OCR_ROOT}/tesseract.esm.min.js`;
        const rawModule = this.options.moduleLoader
          ? await this.options.moduleLoader(moduleUrl)
          : await import(/* @vite-ignore */ moduleUrl);
        const tesseract = resolveTesseractApi(rawModule);

        // Use same-origin worker (workerBlobURL: false) so Service Worker / CacheStorage
        // reliably serves /tesseract/worker.min.js, core WASM files, and eng.traineddata.gz offline.
        return await tesseract.createWorker('eng', 1, {
          workerPath: `${OCR_ROOT}/worker.min.js`,
          corePath: `${OCR_ROOT}/core/`,
          langPath: `${OCR_ROOT}/lang`,
          workerBlobURL: false,
          gzip: true,
          logger: () => undefined
        });
      })().catch((error) => {
        this.workerPromise = null;
        throw error;
      });
    }
    return this.workerPromise;
  }

  private async recognizeWithParams(
    worker: TesseractWorker,
    image: Blob | File,
    psm: '3' | '6' | '11'
  ): Promise<WebMedicineOcrResult> {
    if (typeof worker.setParameters === 'function') {
      try {
        await worker.setParameters({
          tessedit_pageseg_mode: psm,
          preserve_interword_spaces: '1',
          user_defined_dpi: '300'
        });
      } catch {
        // Older/mock workers without setParameters support remain unaffected.
      }
    }
    const result = await worker.recognize(image);
    return {
      text: String(result?.data?.text || '').trim(),
      confidence: Math.max(0, Math.min(100, Number(result?.data?.confidence || 0)))
    };
  }

  public async recognize(image: Blob | File): Promise<WebMedicineOcrResult> {
    if (!(image instanceof Blob) || image.size <= 0) throw new Error('لم يتم اختيار صورة صالحة للدواء');
    if (image.size > 24 * 1024 * 1024) throw new Error('حجم الصورة أكبر من 24 ميجابايت');

    // Serialize worker usage through a queue so concurrent calls reuse one worker safely.
    const task = this.recognizeQueue.then(async () => {
      const prepared = await preprocessImageForOcr(image);
      const worker = await this.getWorker();
      try {
        const primaryInput = prepared?.primaryBlob || image;
        let bestResult = await this.recognizeWithParams(worker, primaryInput, '3');
        let bestScore = scoreOcrTextReadability(bestResult.text, bestResult.confidence);

        if (prepared && (bestScore.isGarbled || bestScore.score < 50 || bestResult.confidence < 72 || (bestScore.dosageCount === 0 && bestScore.pharmaFormCount === 0 && bestResult.confidence < 82))) {
          const binaryBlob = await prepared.buildAdaptiveBinaryBlob();
          if (binaryBlob) {
            const pass2 = await this.recognizeWithParams(worker, binaryBlob, '11');
            const score2 = scoreOcrTextReadability(pass2.text, pass2.confidence);
            if (score2.score > bestScore.score) {
              bestResult = pass2;
              bestScore = score2;
            }
          }

          // Try uniform-block segmentation (PSM 6) on the contrast-enhanced image if still weak/garbled
          if (bestScore.isGarbled || bestScore.score < 50) {
            const pass3 = await this.recognizeWithParams(worker, primaryInput, '6');
            const score3 = scoreOcrTextReadability(pass3.text, pass3.confidence);
            if (score3.score > bestScore.score) {
              bestResult = pass3;
              bestScore = score3;
            }
          }

          // Try 90° and 270° (and 180° fallback) rotations for vertically printed medicine boxes (e.g. Piramyl 4mg)
          if (bestScore.isGarbled || bestScore.score < 60 || bestResult.confidence < 74 || (bestScore.dosageCount === 0 && bestScore.pharmaFormCount === 0)) {
            for (const angle of [90, 270] as const) {
              const rotBlob = await prepared.buildRotatedBlob(angle);
              if (!rotBlob) continue;
              const rotPass = await this.recognizeWithParams(worker, rotBlob, '3');
              const rotScore = scoreOcrTextReadability(rotPass.text, rotPass.confidence);
              if (rotScore.score > bestScore.score) {
                bestResult = rotPass;
                bestScore = rotScore;
              }
            }

            if (bestScore.isGarbled || bestScore.score < 50) {
              const rot180Blob = await prepared.buildRotatedBlob(180);
              if (rot180Blob) {
                const rot180Pass = await this.recognizeWithParams(worker, rot180Blob, '3');
                const rot180Score = scoreOcrTextReadability(rot180Pass.text, rot180Pass.confidence);
                if (rot180Score.score > bestScore.score) {
                  bestResult = rot180Pass;
                  bestScore = rot180Score;
                }
              }
            }
          }
        }

        return bestResult;
      } catch (error) {
        // Reset a broken worker so subsequent retries spawn a clean worker without losing the session.
        this.workerPromise = null;
        try {
          await worker.terminate();
        } catch {
          // Best-effort worker cleanup after failure.
        }
        const reason = error instanceof Error && error.message ? error.message : 'تعذر تحليل الصورة محلياً';
        throw new Error(reason);
      }
    });

    this.recognizeQueue = task.catch(() => undefined);
    return task;
  }

  public async dispose(): Promise<void> {
    await this.recognizeQueue.catch(() => undefined);
    const pending = this.workerPromise;
    this.workerPromise = null;
    if (!pending) return;
    try {
      const worker = await pending;
      await worker.terminate();
    } catch {
      // A failed worker initialization has no live worker to terminate.
    }
  }
}

export const webMedicineTextRecognitionService = new WebMedicineTextRecognitionService();

if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('pagehide', () => {
    void webMedicineTextRecognitionService.dispose();
  });
}
