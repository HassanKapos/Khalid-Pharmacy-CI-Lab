import { Capacitor } from '@capacitor/core';

export type ApiErrorCode =
  | 'NETWORK_ERROR'
  | 'TIMEOUT'
  | 'HTML_FALLBACK'
  | 'HTTP_ERROR'
  | 'INVALID_JSON'
  | 'CONFIG_ERROR';

export interface ApiClientErrorOptions {
  message: string;
  code: ApiErrorCode;
  status?: number;
  url?: string;
  data?: unknown;
  isHtmlFallback?: boolean;
  isTimeout?: boolean;
  isNetworkError?: boolean;
}

export class ApiClientError extends Error {
  readonly code: ApiErrorCode;
  readonly status: number;
  readonly url: string;
  readonly data?: unknown;
  readonly isHtmlFallback: boolean;
  readonly isTimeout: boolean;
  readonly isNetworkError: boolean;

  constructor(opts: ApiClientErrorOptions) {
    super(opts.message);
    this.name = 'ApiClientError';
    this.code = opts.code;
    this.status = opts.status ?? 0;
    this.url = opts.url ?? '';
    this.data = opts.data;
    this.isHtmlFallback = opts.isHtmlFallback ?? (opts.code === 'HTML_FALLBACK');
    this.isTimeout = opts.isTimeout ?? (opts.code === 'TIMEOUT');
    this.isNetworkError = opts.isNetworkError ?? (opts.code === 'NETWORK_ERROR');

    // Maintain proper prototype chain for instanceof checks
    Object.setPrototypeOf(this, ApiClientError.prototype);
  }
}

export interface ApiRequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | string;
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/**
 * Checks whether the application is running inside a native mobile runtime (e.g., Capacitor Android).
 */
export function isNativePlatform(): boolean {
  return typeof Capacitor !== 'undefined' && Capacitor.isNativePlatform();
}

/**
 * Validates that an Android backend URL is non-empty, well-formed, and strictly uses HTTPS.
 * Throws an ApiClientError with code 'CONFIG_ERROR' if invalid.
 */
export function validateBackendUrl(rawUrl: unknown): string {
  const trimmed = typeof rawUrl === 'string' ? rawUrl.trim() : '';

  if (!trimmed) {
    throw new ApiClientError({
      message: 'عنوان الخادم الخلفي (VITE_BACKEND_API_URL) غير مضبوط في تطبيق أندرويد. تم إيقاف الطلب منعاً للفشل والارتباك مع localhost.',
      code: 'CONFIG_ERROR',
      status: 0,
      url: ''
    });
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new ApiClientError({
      message: `عنوان الخادم الخلفي غير صالح في تطبيق أندرويد: "${trimmed}". يرجى تزويد عنوان URL كامل وصحيح.`,
      code: 'CONFIG_ERROR',
      status: 0,
      url: trimmed
    });
  }

  if (parsed.protocol.toLowerCase() !== 'https:' || !parsed.hostname) {
    throw new ApiClientError({
      message: `عنوان الخادم الخلفي في تطبيق أندرويد يجب أن يستخدم بروتوكول مشفر حصراً (https://). تم رفض البروتوكول "${parsed.protocol}".`,
      code: 'CONFIG_ERROR',
      status: 0,
      url: trimmed
    });
  }

  return trimmed.replace(/\/+$/, '');
}

/**
 * Resolves the backend base URL:
 * - On Native Android: Must be explicitly configured via VITE_BACKEND_API_URL and strictly enforce HTTPS.
 *   If missing, empty, invalid, or non-HTTPS, throws an explicit ApiClientError (never falls back to localhost).
 * - On Web: Returns empty string ("") so that browser requests use relative paths against current origin.
 */
export function getBackendBaseUrl(): string {
  if (isNativePlatform()) {
    const rawUrl = import.meta.env?.VITE_BACKEND_API_URL;
    return validateBackendUrl(rawUrl);
  }

  // Web environment uses relative pathing directly
  return '';
}

/**
 * Resolves an API or resource endpoint to a fully qualified URL on Android or a relative path on Web.
 */
export function resolveApiUrl(endpoint: string): string {
  if (!endpoint) return '';

  // Return absolute HTTP(S) or Data/Blob URLs as-is
  if (/^(?:https?:\/\/|data:|blob:)/i.test(endpoint)) {
    return endpoint;
  }

  const base = getBackendBaseUrl();
  const cleanPath = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;

  return base ? `${base}${cleanPath}` : cleanPath;
}

/**
 * Resolves receipt and document image URLs safely:
 * - Preserves inline base64 data URLs and blob URLs directly
 * - Prepends remote backend URL in native Android
 * - Uses relative path on Web
 */
export function resolveImageUrl(imagePath: string): string {
  if (!imagePath) return '';
  if (/^(?:data:|blob:|https?:\/\/)/i.test(imagePath)) {
    return imagePath;
  }
  return resolveApiUrl(imagePath);
}

/**
 * Unified API Client for Khalid Pharmacy:
 * - Automatically routes relative paths on Web and configured HTTPS endpoints on Android
 * - Rejects unconfigured Android backend addresses safely (no localhost fallbacks)
 * - Intercepts HTML fallback responses from Capacitor AssetLoader to prevent JSON SyntaxError
 * - Supports configurable timeouts and caller-driven AbortSignal
 * - Properly handles JSON and FormData payloads without breaking multipart boundaries
 */
export class ApiClient {
  private defaultTimeoutMs: number = 35000;

  constructor(defaultTimeoutMs: number = 35000) {
    this.defaultTimeoutMs = defaultTimeoutMs;
  }

  /**
   * Expose current base URL for Web Worker config or diagnostics.
   */
  getBaseUrl(): string {
    return getBackendBaseUrl();
  }

  /**
   * Expose platform check.
   */
  isNative(): boolean {
    return isNativePlatform();
  }

  /**
   * Expose URL resolver.
   */
  resolveUrl(endpoint: string): string {
    return resolveApiUrl(endpoint);
  }

  /**
   * Expose Image URL resolver.
   */
  resolveImageUrl(imagePath: string): string {
    return resolveImageUrl(imagePath);
  }

  /**
   * Execute an HTTP request with safe routing, timeout, and response validation.
   */
  async request<T = unknown>(endpoint: string, options: ApiRequestOptions = {}): Promise<T> {
    const targetUrl = this.resolveUrl(endpoint);
    const method = (options.method || 'GET').toUpperCase();
    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;

    // Setup combined abort controller for timeout and external signal
    const timeoutController = new AbortController();
    let abortListener: (() => void) | null = null;

    if (options.signal) {
      if (options.signal.aborted) {
        timeoutController.abort(options.signal.reason);
      } else {
        abortListener = () => timeoutController.abort(options.signal?.reason);
        options.signal.addEventListener('abort', abortListener, { once: true });
      }
    }

    const timerId = setTimeout(() => {
      timeoutController.abort(new Error(`TIMEOUT_${timeoutMs}MS`));
    }, timeoutMs);

    // Prepare headers and body
    const requestHeaders: Record<string, string> = { ...(options.headers || {}) };
    let requestBody: BodyInit | undefined;

    const rawBody = options.body;
    if (rawBody instanceof FormData) {
      // CRITICAL: When using FormData, let the browser define multipart/form-data with the boundary parameter
      delete requestHeaders['Content-Type'];
      delete requestHeaders['content-type'];
      requestBody = rawBody;
    } else if (rawBody !== undefined && rawBody !== null) {
      if (
        typeof rawBody === 'string' ||
        rawBody instanceof Blob ||
        rawBody instanceof ArrayBuffer ||
        rawBody instanceof Uint8Array
      ) {
        requestBody = rawBody as BodyInit;
      } else {
        if (!requestHeaders['Content-Type'] && !requestHeaders['content-type']) {
          requestHeaders['Content-Type'] = 'application/json';
        }
        requestBody = JSON.stringify(rawBody);
      }
    }

    let response: Response;
    try {
      response = await fetch(targetUrl, {
        method,
        headers: requestHeaders,
        body: requestBody,
        signal: timeoutController.signal
      });
    } catch (fetchErr: unknown) {
      clearTimeout(timerId);
      if (abortListener && options.signal) {
        options.signal.removeEventListener('abort', abortListener);
      }

      if (timeoutController.signal.aborted) {
        if (options.signal?.aborted) {
          throw new ApiClientError({
            message: 'تم إلغاء الطلب من قبل المستخدم.',
            code: 'NETWORK_ERROR',
            status: 0,
            url: targetUrl,
            isNetworkError: true
          });
        }
        throw new ApiClientError({
          message: `انتهت مهلة انتظار استجابة الخادم (${timeoutMs}ms). يرجى التحقق من جودة الاتصال وإعادة المحاولة.`,
          code: 'TIMEOUT',
          status: 0,
          url: targetUrl,
          isTimeout: true
        });
      }

      const rawMsg = fetchErr instanceof Error ? fetchErr.message : String(fetchErr);
      throw new ApiClientError({
        message: `تعذر الاتصال بالخادم: ${rawMsg || 'خطأ في الشبكة'}.`,
        code: 'NETWORK_ERROR',
        status: 0,
        url: targetUrl,
        isNetworkError: true
      });
    } finally {
      clearTimeout(timerId);
      if (abortListener && options.signal) {
        options.signal.removeEventListener('abort', abortListener);
      }
    }

    // Intercept HTML responses from local assets or fallback index.html
    const contentType = response.headers.get('content-type') || '';
    if (contentType.toLowerCase().includes('text/html')) {
      throw new ApiClientError({
        message: `استجاب التطبيق بصفحة HTML بدلاً من بيانات JSON (كود HTTP ${response.status}). في تطبيق أندرويد، يشير ذلك إلى توجيه الطلب إلى مسارات الأصول المحلية (index.html) بدلاً من الخادم الخلفي الحقيقي.`,
        code: 'HTML_FALLBACK',
        status: response.status,
        url: targetUrl,
        isHtmlFallback: true
      });
    }

    // Handle HTTP error responses
    if (!response.ok) {
      let errorData: unknown = null;
      try {
        errorData = await response.json();
      } catch {
        try {
          errorData = await response.text();
        } catch {
          // ignore
        }
      }

      let errorMsg = `فشل الطلب مع كود الاستجابة HTTP ${response.status}`;
      if (errorData && typeof errorData === 'object') {
        const obj = errorData as Record<string, unknown>;
        if (typeof obj.error === 'string') {
          errorMsg = obj.error;
        } else if (typeof obj.message === 'string') {
          errorMsg = obj.message;
        }
      } else if (typeof errorData === 'string' && errorData.trim().length > 0 && errorData.length < 250) {
        errorMsg = errorData.trim();
      }

      throw new ApiClientError({
        message: errorMsg,
        code: 'HTTP_ERROR',
        status: response.status,
        url: targetUrl,
        data: errorData
      });
    }

    // Handle empty 204 No Content responses safely
    if (response.status === 204 || response.headers.get('content-length') === '0') {
      return null as T;
    }

    const responseText = await response.text();
    if (!responseText || !responseText.trim()) {
      return null as T;
    }

    try {
      return JSON.parse(responseText) as T;
    } catch (parseErr: unknown) {
      const parseMsg = parseErr instanceof Error ? parseErr.message : String(parseErr);
      throw new ApiClientError({
        message: `فشل في قراءة استجابة الخادم كـ JSON صالح: ${parseMsg}`,
        code: 'INVALID_JSON',
        status: response.status,
        url: targetUrl
      });
    }
  }

  /**
   * Helper: GET request
   */
  async get<T = unknown>(endpoint: string, options?: Omit<ApiRequestOptions, 'method' | 'body'>): Promise<T> {
    return this.request<T>(endpoint, { ...options, method: 'GET' });
  }

  /**
   * Helper: POST request
   */
  async post<T = unknown>(endpoint: string, body?: unknown, options?: Omit<ApiRequestOptions, 'method' | 'body'>): Promise<T> {
    return this.request<T>(endpoint, { ...options, method: 'POST', body });
  }

  /**
   * Helper: PUT request
   */
  async put<T = unknown>(endpoint: string, body?: unknown, options?: Omit<ApiRequestOptions, 'method' | 'body'>): Promise<T> {
    return this.request<T>(endpoint, { ...options, method: 'PUT', body });
  }

  /**
   * Helper: DELETE request
   */
  async delete<T = unknown>(endpoint: string, options?: Omit<ApiRequestOptions, 'method' | 'body'>): Promise<T> {
    return this.request<T>(endpoint, { ...options, method: 'DELETE' });
  }

  /**
   * Fetches an image securely via the unified client, validating Content-Type,
   * and returning a local object URL (blob:...).
   * 
   * This architecture cleanly accommodates future Authorization Bearer tokens
   * or HMAC authentication headers without leaking tokens into img src query strings.
   */
  async fetchImageBlob(imagePath: string, options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<string> {
    const targetUrl = this.resolveImageUrl(imagePath);
    if (!targetUrl) return '';

    // If it's already an in-memory data URL or blob URL, return directly
    if (/^(?:data:|blob:)/i.test(targetUrl)) {
      return targetUrl;
    }

    const timeoutMs = options?.timeoutMs ?? this.defaultTimeoutMs;
    const timeoutController = new AbortController();

    if (options?.signal) {
      options.signal.addEventListener('abort', () => timeoutController.abort(options.signal?.reason), { once: true });
    }

    const timerId = setTimeout(() => {
      timeoutController.abort(new Error(`TIMEOUT_${timeoutMs}MS`));
    }, timeoutMs);

    try {
      const response = await fetch(targetUrl, {
        method: 'GET',
        signal: timeoutController.signal
      });

      if (!response.ok) {
        throw new ApiClientError({
          message: `فشل تحميل صورة الإشعار (HTTP ${response.status})`,
          code: 'HTTP_ERROR',
          status: response.status,
          url: targetUrl
        });
      }

      const contentType = response.headers.get('content-type') || '';
      if (contentType.toLowerCase().includes('text/html')) {
        throw new ApiClientError({
          message: 'تم إرجاع صفحة HTML بدلاً من ملف الصورة',
          code: 'HTML_FALLBACK',
          status: response.status,
          url: targetUrl,
          isHtmlFallback: true
        });
      }

      const blob = await response.blob();
      return URL.createObjectURL(blob);
    } finally {
      clearTimeout(timerId);
    }
  }
}

export const apiClient = new ApiClient();
export default apiClient;
