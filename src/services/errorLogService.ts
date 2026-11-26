/**
 * Local, privacy-conscious diagnostics for Khalid Pharmacy.
 *
 * This database is deliberately separate from KhalidPharmacyDB: diagnostics
 * must never participate in pharmacy transactions or change the stock schema.
 */
export type ErrorLogLevel = 'error' | 'warning' | 'info';

export interface ErrorLogInput {
  level?: ErrorLogLevel;
  source: string;
  operation?: string;
  error: unknown;
  correlationId?: string;
}

export interface ErrorLogEntry {
  id: string;
  timestamp: string;
  level: ErrorLogLevel;
  source: string;
  operation: string;
  message: string;
  stack?: string;
  appVersion: string;
  platform: 'android' | 'web' | 'unknown';
  correlationId: string;
  occurrenceCount: number;
}

const DEFAULT_DB_NAME = 'KhalidPharmacyDiagnosticsDB';
const STORE_NAME = 'error_logs';
const DB_VERSION = 1;
const MAX_ENTRIES = 500;
const MAX_MESSAGE_LENGTH = 1000;
const MAX_STACK_LENGTH = 6000;

function makeId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
  } catch {
    // Continue with a non-cryptographic diagnostic identifier.
  }
  return `diag-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function redactSensitiveText(value: string): string {
  return value
    // Authorization headers may appear as "Bearer <token>", "Basic <creds>", or as a raw value.
    .replace(/(["']?authorization["']?\s*[:=]\s*["']?)(?:(?:bearer|basic)\s+)?[^"'\s,;}&]+/gi, '$1[REDACTED]')
    .replace(/\b(bearer|basic)\s+[A-Za-z0-9._~+\/-]+=*/gi, '$1 [REDACTED]')
    // Redact OAuth authorization codes carried in redirect/callback query strings.
    .replace(/([?&](?:auth[_-]?code|code)=)[^&\s#"']+/gi, '$1[REDACTED]')
    // Covers JSON fields (including quoted multi-word values), query parameters, and key=value error messages.
    .replace(
      /((?:["']?(?:access|refresh|id)[_-]?token|token|password|passwd|passphrase|secret|api[_-]?key|x[_-]?api[_-]?key|private[_-]?key|client[_-]?secret|client[_-]?id)["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^"'&\s,;}\]]+)/gi,
      '$1[REDACTED]'
    )
    .replace(/\bya29\.[A-Za-z0-9._-]+/g, '[REDACTED_GOOGLE_TOKEN]')
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '[REDACTED_JWT]');
}

function errorDetails(error: unknown): { message: string; stack?: string } {
  if (error instanceof Error) {
    return {
      message: redactSensitiveText(error.message || error.name || 'Unknown error').slice(0, MAX_MESSAGE_LENGTH),
      stack: error.stack ? redactSensitiveText(error.stack).slice(0, MAX_STACK_LENGTH) : undefined,
    };
  }

  let message = 'Unknown error';
  if (typeof error === 'string') {
    message = error;
  } else if (error !== undefined && error !== null) {
    try {
      message = JSON.stringify(error);
    } catch {
      message = Object.prototype.toString.call(error);
    }
  }

  return { message: redactSensitiveText(message).slice(0, MAX_MESSAGE_LENGTH) };
}

function getPlatform(): ErrorLogEntry['platform'] {
  try {
    if (typeof navigator === 'undefined') return 'unknown';
    return /Android/i.test(navigator.userAgent) ? 'android' : 'web';
  } catch {
    return 'unknown';
  }
}

export class ErrorLogService {
  private databasePromise: Promise<IDBDatabase> | null = null;
  private handlersInstalled = false;
  private lastTimestampMs = 0;
  private accessChecker: (() => boolean) | null = null;

  private readonly databaseName: string;
  private readonly maxEntries: number;

  constructor(databaseName = DEFAULT_DB_NAME, maxEntries = MAX_ENTRIES) {
    this.databaseName = databaseName;
    this.maxEntries = maxEntries;
  }

  setAccessChecker(checker: (() => boolean) | null): void {
    this.accessChecker = checker;
  }

  private canReadDiagnostics(): boolean {
    if (!this.accessChecker) return true;
    try {
      return Boolean(this.accessChecker());
    } catch {
      return false;
    }
  }

  private openDatabase(): Promise<IDBDatabase> {
    if (this.databasePromise) return this.databasePromise;

    this.databasePromise = new Promise((resolve, reject) => {
      try {
        if (typeof indexedDB === 'undefined') {
          reject(new Error('IndexedDB is not available in this environment'));
          return;
        }

        const request = indexedDB.open(this.databaseName, DB_VERSION);
        request.onupgradeneeded = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains(STORE_NAME)) {
            const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' });
            store.createIndex('timestamp', 'timestamp', { unique: false });
            store.createIndex('level', 'level', { unique: false });
            store.createIndex('source', 'source', { unique: false });
          }
        };
        request.onsuccess = () => {
          const db = request.result;
          db.onversionchange = () => {
            db.close();
            this.databasePromise = null;
          };
          db.onclose = () => {
            this.databasePromise = null;
          };
          resolve(db);
        };
        request.onerror = () => {
          this.databasePromise = null;
          reject(request.error || new Error('Unable to open diagnostics database'));
        };
        request.onblocked = () => {
          this.databasePromise = null;
          reject(new Error('Diagnostics database upgrade is blocked'));
        };
      } catch (error) {
        this.databasePromise = null;
        reject(error);
      }
    });

    return this.databasePromise;
  }

  /**
   * Best-effort write: logger failures are intentionally swallowed and must
   * never interrupt POS, inventory, sales, or backup operations.
   */
  async recordError(input: ErrorLogInput): Promise<void> {
    try {
      const db = await this.openDatabase();
      const details = errorDetails(input.error);
      this.lastTimestampMs = Math.max(Date.now(), this.lastTimestampMs + 1);
      const entry: ErrorLogEntry = {
        id: makeId(),
        timestamp: new Date(this.lastTimestampMs).toISOString(),
        level: input.level || 'error',
        source: redactSensitiveText(String(input.source || 'application')).slice(0, 80),
        operation: redactSensitiveText(String(input.operation || 'unspecified')).slice(0, 120),
        message: details.message,
        stack: details.stack,
        appVersion: '0.0.0',
        platform: getPlatform(),
        correlationId: redactSensitiveText(String(input.correlationId || makeId())).slice(0, 120),
        occurrenceCount: 1,
      };

      await new Promise<void>((resolve, reject) => {
        const transaction = db.transaction(STORE_NAME, 'readwrite');
        const store = transaction.objectStore(STORE_NAME);
        store.add(entry);

        const allRequest = store.getAll();
        allRequest.onsuccess = () => {
          const records = (allRequest.result as ErrorLogEntry[])
            .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
          const overflow = records.length - Math.max(1, this.maxEntries);
          for (let index = 0; index < overflow; index += 1) {
            store.delete(records[index].id);
          }
        };

        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error || new Error('Diagnostics write failed'));
        transaction.onabort = () => reject(transaction.error || new Error('Diagnostics write aborted'));
      });
    } catch {
      // Deliberately silent to avoid recursive error logging and business impact.
    }
  }

  async list(options: { limit?: number; level?: ErrorLogLevel | 'all' } = {}): Promise<ErrorLogEntry[]> {
    if (!this.canReadDiagnostics()) return [];
    try {
      const db = await this.openDatabase();
      const entries = await new Promise<ErrorLogEntry[]>((resolve, reject) => {
        const transaction = db.transaction(STORE_NAME, 'readonly');
        const request = transaction.objectStore(STORE_NAME).getAll();
        request.onsuccess = () => resolve(request.result as ErrorLogEntry[]);
        request.onerror = () => reject(request.error || new Error('Unable to read diagnostics'));
      });
      const filtered = entries
        .filter((entry) => !options.level || options.level === 'all' || entry.level === options.level)
        .sort((a, b) => b.timestamp.localeCompare(a.timestamp));
      const limit = Math.max(1, Math.min(500, Number(options.limit) || MAX_ENTRIES));
      return filtered.slice(0, limit);
    } catch {
      return [];
    }
  }

  async clear(): Promise<boolean> {
    if (!this.canReadDiagnostics()) return false;
    try {
      const db = await this.openDatabase();
      await new Promise<void>((resolve, reject) => {
        const transaction = db.transaction(STORE_NAME, 'readwrite');
        transaction.objectStore(STORE_NAME).clear();
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error || new Error('Unable to clear diagnostics'));
        transaction.onabort = () => reject(transaction.error || new Error('Diagnostics clear aborted'));
      });
      return true;
    } catch {
      return false;
    }
  }

  async exportJSON(): Promise<string> {
    if (!this.canReadDiagnostics()) {
      throw new Error('Admin access required to read or export diagnostic logs');
    }
    const entries = await this.list({ limit: MAX_ENTRIES });
    return JSON.stringify({
      exportedAt: new Date().toISOString(),
      app: 'Khalid Pharmacy',
      count: entries.length,
      entries,
    }, null, 2);
  }

  installGlobalHandlers(): void {
    if (this.handlersInstalled || typeof window === 'undefined') return;
    this.handlersInstalled = true;

    window.addEventListener('error', (event: ErrorEvent) => {
      void this.recordError({
        level: 'error',
        source: 'window',
        operation: 'uncaught-error',
        error: event.error || event.message || 'Uncaught window error',
      });
    });

    window.addEventListener('unhandledrejection', (event: PromiseRejectionEvent) => {
      void this.recordError({
        level: 'error',
        source: 'promise',
        operation: 'unhandled-rejection',
        error: event.reason,
      });
    });
  }
}

export const errorLogService = new ErrorLogService();
