import type { IBarcodeDecoderEngine, BarcodeEngineResult, EngineName, EngineBenchmarkResult } from './types';
import { NativeEngineAdapter } from './NativeEngine';
import { ZXingWasmEngineAdapter } from './ZXingWasmEngine';
import { ZXingJSEngineAdapter } from './ZXingJSEngine';

export class BarcodeEngineManager {
  private engines: Map<EngineName, IBarcodeDecoderEngine> = new Map();
  private activeEngineName: EngineName = 'zxing-wasm';
  private consecutiveMisses = 0;
  private fallbackReason: string | null = null;

  constructor() {
    this.engines.set('native', new NativeEngineAdapter());
    this.engines.set('zxing-wasm', new ZXingWasmEngineAdapter());
    this.engines.set('zxing-js', new ZXingJSEngineAdapter());
  }

  async initAll(): Promise<void> {
    const nativeAdapter = this.engines.get('native')!;
    const wasmAdapter = this.engines.get('zxing-wasm')!;
    const jsAdapter = this.engines.get('zxing-js')!;

    await Promise.all([
      nativeAdapter.init(),
      wasmAdapter.init(),
      jsAdapter.init()
    ]);

    // Select primary active engine
    if (nativeAdapter.isAvailable()) {
      this.activeEngineName = 'native';
      this.fallbackReason = null;
    } else if (wasmAdapter.isAvailable()) {
      this.activeEngineName = 'zxing-wasm';
      this.fallbackReason = 'تم اختيار zxing-wasm لعدم توفر Native BarcodeDetector متوافق مع نظام التشغيل';
    } else {
      this.activeEngineName = 'zxing-js';
      this.fallbackReason = 'تم اختيار zxing-js لعدم توفر محركات أعلى';
    }
  }

  getActiveEngineName(): EngineName {
    return this.activeEngineName;
  }

  getFallbackReason(): string | null {
    return this.fallbackReason;
  }

  setActiveEngine(name: EngineName): void {
    if (this.engines.has(name) && this.engines.get(name)!.isAvailable()) {
      this.activeEngineName = name;
      this.consecutiveMisses = 0;
    }
  }

  /**
   * Smart Decode Strategy:
   * Uses the currently active engine. If Native misses 6 times or fails, switches to WASM.
   * If WASM fails or throws, switches to JS fallback.
   * Prevents running all engines on every frame to save CPU and battery.
   */
  async decodeFrame(
    source: HTMLVideoElement | ImageBitmap | ImageData | HTMLCanvasElement,
    width?: number,
    height?: number
  ): Promise<BarcodeEngineResult | null> {
    const activeEngine = this.engines.get(this.activeEngineName);

    if (activeEngine && activeEngine.isAvailable()) {
      try {
        const result = await activeEngine.decode(source, width, height);
        if (result) {
          this.consecutiveMisses = 0;
          return result;
        } else {
          this.consecutiveMisses++;
          // High-Performance Failover: if Native misses on a frame, immediately try WASM so no frame is wasted!
          if (this.activeEngineName === 'native') {
            const wasmEngine = this.engines.get('zxing-wasm');
            if (wasmEngine && wasmEngine.isAvailable()) {
              try {
                const wasmResult = await wasmEngine.decode(source, width, height);
                if (wasmResult) {
                  this.activeEngineName = 'zxing-wasm';
                  this.fallbackReason = 'تم اعتماد zxing-wasm تلقائياً لسرعة ودقة التقاط الباركود';
                  this.consecutiveMisses = 0;
                  return wasmResult;
                }
              } catch (wasmErr: any) {
                console.warn('[EngineManager] Error in zxing-wasm during native fallback:', wasmErr);
                this.activeEngineName = 'zxing-js';
                this.fallbackReason = `استثناء في zxing-wasm (${wasmErr?.message || 'خطأ غير معروف'}) -> تحويل لـ zxing-js`;
                this.consecutiveMisses = 10;
                return null;
              }
            }
            if (this.consecutiveMisses >= 3) {
              if (wasmEngine && wasmEngine.isAvailable()) {
                this.activeEngineName = 'zxing-wasm';
                this.fallbackReason = 'تحويل تلقائي لـ zxing-wasm لتعزيز حساسية القراءة';
                this.consecutiveMisses = 0;
              }
            }
          }
        }
      } catch (err: any) {
        console.warn(`[EngineManager] Error in ${this.activeEngineName}:`, err);
        this.consecutiveMisses = 10;
        // Immediate failover to WASM or JS
        if (this.activeEngineName === 'native') {
          this.activeEngineName = 'zxing-wasm';
          this.fallbackReason = `استثناء في Native Engine (${err?.message || 'خطأ غير معروف'}) -> تحويل لـ zxing-wasm`;
        } else if (this.activeEngineName === 'zxing-wasm') {
          this.activeEngineName = 'zxing-js';
          this.fallbackReason = `استثناء في zxing-wasm -> تحويل لـ zxing-js`;
        }
      }
    } else {
      // Primary unavailable, fallback to WASM or JS
      const wasm = this.engines.get('zxing-wasm');
      if (wasm && wasm.isAvailable()) {
        this.activeEngineName = 'zxing-wasm';
        try {
          return await wasm.decode(source, width, height);
        } catch (wasmErr: any) {
          console.warn('[EngineManager] Error in zxing-wasm fallback:', wasmErr);
          this.fallbackReason = `استثناء في zxing-wasm -> تحويل لـ zxing-js`;
        }
      }
      const js = this.engines.get('zxing-js');
      if (js && js.isAvailable()) {
        this.activeEngineName = 'zxing-js';
        try {
          return await js.decode(source, width, height);
        } catch (jsErr: any) {
          console.warn('[EngineManager] Error in zxing-js fallback:', jsErr);
        }
      }
    }

    return null;
  }

  /**
   * Comparative Benchmark Execution:
   * Executes identical sample ImageData across all 3 engines sequentially
   * to record digital metrics (decodeTimeMs, success, error) for diagnostic comparison.
   */
  async runComparativeBenchmark(
    testImageData: ImageData,
    iterations = 5
  ): Promise<EngineBenchmarkResult[]> {
    const results: EngineBenchmarkResult[] = [];

    for (const [name, engine] of this.engines.entries()) {
      const isAvailable = engine.isAvailable();
      if (!isAvailable) {
        results.push({
          engineName: name,
          supported: false,
          initSuccess: false,
          avgDecodeTimeMs: 0,
          successRatePercent: 0,
          decodesCount: 0,
          lastDecodedBarcode: null,
          errorReason: 'Engine not supported or unavailable'
        });
        continue;
      }

      let totalTimeMs = 0;
      let successes = 0;
      let lastBarcode: string | null = null;
      let errorMsg: string | null = null;

      for (let i = 0; i < iterations; i++) {
        try {
          const res = await engine.decode(testImageData);
          if (res) {
            successes++;
            totalTimeMs += res.decodeTimeMs;
            lastBarcode = res.barcode;
          }
        } catch (e: any) {
          errorMsg = e?.message || 'Decode exception';
        }
      }

      const avgTime = successes > 0 ? Math.round(totalTimeMs / successes) : 0;
      const rate = Math.round((successes / iterations) * 100);

      results.push({
        engineName: name,
        supported: true,
        initSuccess: true,
        avgDecodeTimeMs: avgTime,
        successRatePercent: rate,
        decodesCount: successes,
        lastDecodedBarcode: lastBarcode,
        errorReason: errorMsg
      });
    }

    return results;
  }

  destroyAll(): void {
    for (const engine of this.engines.values()) {
      try {
        engine.destroy();
      } catch {}
    }
  }
}
