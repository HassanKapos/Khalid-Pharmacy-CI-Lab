/**
 * M-30 — Real Browser E2E Verification: Same-Origin Policy (SOP),
 * IndexedDB, LocalStorage, and Browser-Profile Isolation Boundary.
 *
 * Security Spec Reference: Phase 2E-B.2 / R3.2 Security Matrix Case M-30
 *
 * Execution Requirements:
 * - Zero paid services, zero external npm dependencies, 100% synthetic fixtures.
 * - Launches REAL headless Chromium/Google Chrome via Chrome DevTools Protocol (CDP)
 *   over native Node sockets (RFC 6455). Fails closed if no real browser binary exists.
 *
 * Verified Assertions (M-30.1 .. M-30.7):
 * - M-30.1: Origin A persists synthetic financial records in real Browser IndexedDB & localStorage.
 * - M-30.2: Cross-origin localStorage isolation (Origin B in same Chrome profile reads 0 keys).
 * - M-30.3: Cross-origin IndexedDB isolation (Origin B in same Chrome profile sees 0 records).
 * - M-30.4: Cross-origin iframe DOM/localStorage access blocked by browser SecurityError (SOP).
 * - M-30.5: Cross-origin fetch() without CORS blocked by browser SOP (no financial data exfiltration).
 * - M-30.6: Same-origin same-profile residual exposure proof (R3.2 negative audit: confirms Cloud Rules
 *           alone cannot isolate shared same-origin same-profile browser storage).
 * - M-30.7: Separate Chrome profile (--user-data-dir) on same Origin A sees 0 IndexedDB/localStorage data
 *           (proves R3.2 mitigation), plus explicit logout wipe verification removes residual data.
 */

import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

interface CdpResponse {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { code?: number; message?: string };
}

/**
 * Minimal RFC 6455 WebSocket client over node:net (works across Node 18/20/22/24 with zero deps).
 */
class MinimalCdpSocket {
  private socket: net.Socket;
  private buffer = Buffer.alloc(0);
  private pending = new Map<number, { resolve: (val: Record<string, unknown>) => void; reject: (err: Error) => void }>();
  private nextId = 1;
  private closed = false;

  private constructor(socket: net.Socket) {
    this.socket = socket;
    this.socket.on('data', (chunk: Buffer) => this.onData(chunk));
    this.socket.on('close', () => {
      this.closed = true;
      for (const [, p] of this.pending) {
        p.reject(new Error('CDP WebSocket closed before response'));
      }
      this.pending.clear();
    });
    this.socket.on('error', (err) => {
      for (const [, p] of this.pending) {
        p.reject(err);
      }
      this.pending.clear();
    });
  }

  static async connect(wsUrl: string): Promise<MinimalCdpSocket> {
    const parsed = new URL(wsUrl);
    const host = parsed.hostname;
    const port = Number(parsed.port || 80);
    const resourcePath = `${parsed.pathname}${parsed.search}`;
    const key = crypto.randomBytes(16).toString('base64');

    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ host, port });
      let headerBuf = Buffer.alloc(0);
      let upgraded = false;

      const onError = (err: Error) => {
        if (!upgraded) reject(err);
      };
      socket.once('error', onError);

      socket.once('connect', () => {
        const req =
          `GET ${resourcePath} HTTP/1.1\r\n` +
          `Host: ${host}:${port}\r\n` +
          `Upgrade: websocket\r\n` +
          `Connection: Upgrade\r\n` +
          `Sec-WebSocket-Key: ${key}\r\n` +
          `Sec-WebSocket-Version: 13\r\n\r\n`;
        socket.write(req);
      });

      const onHandshake = (chunk: Buffer) => {
        headerBuf = Buffer.concat([headerBuf, chunk]);
        const idx = headerBuf.indexOf('\r\n\r\n');
        if (idx === -1) return;
        const head = headerBuf.subarray(0, idx).toString('utf8');
        const rest = headerBuf.subarray(idx + 4);
        socket.off('data', onHandshake);
        socket.off('error', onError);
        if (!head.startsWith('HTTP/1.1 101')) {
          socket.destroy();
          reject(new Error(`CDP WebSocket handshake failed: ${head.split('\r\n')[0]}`));
          return;
        }
        upgraded = true;
        const client = new MinimalCdpSocket(socket);
        if (rest.length > 0) client.onData(rest);
        resolve(client);
      };
      socket.on('data', onHandshake);
    });
  }

  private writeFrame(opcode: number, payload: Buffer): void {
    const mask = crypto.randomBytes(4);
    const len = payload.length;
    let header: Buffer;
    if (len < 126) {
      header = Buffer.alloc(2);
      header[0] = 0x80 | (opcode & 0x0f);
      header[1] = 0x80 | len;
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | (opcode & 0x0f);
      header[1] = 0x80 | 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | (opcode & 0x0f);
      header[1] = 0x80 | 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    const masked = Buffer.alloc(len);
    for (let i = 0; i < len; i++) {
      masked[i] = payload[i] ^ mask[i % 4];
    }
    this.socket.write(Buffer.concat([header, mask, masked]));
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 2) {
      const b0 = this.buffer[0];
      const b1 = this.buffer[1];
      const opcode = b0 & 0x0f;
      const isMasked = (b1 & 0x80) !== 0;
      let payloadLen = b1 & 0x7f;
      let offset = 2;

      if (payloadLen === 126) {
        if (this.buffer.length < offset + 2) return;
        payloadLen = this.buffer.readUInt16BE(offset);
        offset += 2;
      } else if (payloadLen === 127) {
        if (this.buffer.length < offset + 8) return;
        payloadLen = Number(this.buffer.readBigUInt64BE(offset));
        offset += 8;
      }

      const maskLen = isMasked ? 4 : 0;
      if (this.buffer.length < offset + maskLen + payloadLen) return;

      let payload = this.buffer.subarray(offset + maskLen, offset + maskLen + payloadLen);
      if (isMasked) {
        const maskKey = this.buffer.subarray(offset, offset + 4);
        const unmasked = Buffer.alloc(payloadLen);
        for (let i = 0; i < payloadLen; i++) {
          unmasked[i] = payload[i] ^ maskKey[i % 4];
        }
        payload = unmasked;
      }
      this.buffer = this.buffer.subarray(offset + maskLen + payloadLen);

      if (opcode === 0x09) {
        // Ping -> Pong
        this.writeFrame(0x0a, payload);
      } else if (opcode === 0x08) {
        this.close();
        return;
      } else if (opcode === 0x01) {
        const msg = JSON.parse(payload.toString('utf8')) as CdpResponse;
        if (typeof msg.id === 'number') {
          const entry = this.pending.get(msg.id);
          if (entry) {
            this.pending.delete(msg.id);
            if (msg.error) {
              entry.reject(new Error(`CDP error ${msg.error.code ?? ''}: ${msg.error.message ?? 'unknown'}`));
            } else {
              entry.resolve(msg.result ?? {});
            }
          }
        }
      }
    }
  }

  send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<Record<string, unknown>> {
    if (this.closed) return Promise.reject(new Error('CDP socket already closed'));
    const id = this.nextId++;
    const body: Record<string, unknown> = { id, method, params };
    if (sessionId) body.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) {
          reject(new Error(`CDP command timed out: ${method}`));
        }
      }, 20_000);
      this.pending.set(id, {
        resolve: (val) => {
          clearTimeout(timer);
          resolve(val);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });
      this.writeFrame(0x01, Buffer.from(JSON.stringify(body), 'utf8'));
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.socket.destroy();
    } catch {
      // ignore
    }
  }
}

function findRealBrowserBinary(): string {
  const candidates = [
    process.env.CHROME_BIN,
    process.env.CHROMIUM_BIN,
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].filter((p): p is string => Boolean(p));

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error(
    'M-30_BROWSER_BINARY_NOT_FOUND: No real Chrome/Chromium binary found (checked CHROME_BIN and standard paths). Refusing to fake or skip M-30.'
  );
}

interface LaunchedBrowser {
  proc: ChildProcess;
  userDataDir: string;
  cdp: MinimalCdpSocket;
  version: string;
  close: () => Promise<void>;
}

async function launchRealChrome(browserBin: string, profileLabel: string): Promise<LaunchedBrowser> {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), `khalid-m30-${profileLabel}-`));
  const proc = spawn(
    browserBin,
    [
      '--headless=new',
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--disable-extensions',
      '--no-first-run',
      '--no-default-browser-check',
      '--remote-debugging-port=0',
      `--user-data-dir=${userDataDir}`,
      'about:blank',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  );

  const wsUrl = await new Promise<string>((resolve, reject) => {
    let stderrBuf = '';
    const timer = setTimeout(() => {
      reject(new Error(`Timed out waiting for Chrome DevTools endpoint (${profileLabel}). stderr=${stderrBuf.slice(-400)}`));
    }, 20_000);

    proc.stderr?.on('data', (chunk: Buffer) => {
      stderrBuf += chunk.toString('utf8');
      const m = stderrBuf.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (m) {
        clearTimeout(timer);
        resolve(m[1]);
      }
    });

    proc.once('exit', (code, signal) => {
      clearTimeout(timer);
      reject(new Error(`Chrome exited prematurely (${profileLabel}): code=${code}, signal=${signal}. stderr=${stderrBuf.slice(-400)}`));
    });
  });

  const cdp = await MinimalCdpSocket.connect(wsUrl);
  const verInfo = await cdp.send('Browser.getVersion');
  const version = String(verInfo.product ?? 'unknown-chromium');

  const close = async () => {
    try {
      await cdp.send('Browser.close').catch(() => undefined);
    } finally {
      cdp.close();
      if (!proc.killed) proc.kill('SIGKILL');
      await new Promise((r) => setTimeout(r, 150));
      fs.rmSync(userDataDir, { recursive: true, force: true });
    }
  };

  return { proc, userDataDir, cdp, version, close };
}

async function openTabAndEval<T>(browser: LaunchedBrowser, url: string, expression: string): Promise<T> {
  const created = await browser.cdp.send('Target.createTarget', { url: 'about:blank' });
  const targetId = String(created.targetId);
  const attached = await browser.cdp.send('Target.attachToTarget', { targetId, flatten: true });
  const sessionId = String(attached.sessionId);

  try {
    await browser.cdp.send('Page.enable', {}, sessionId);
    await browser.cdp.send('Runtime.enable', {}, sessionId);
    await browser.cdp.send('Page.navigate', { url }, sessionId);

    // Wait until document.readyState === 'complete' and expected origin is loaded
    const expectedOrigin = new URL(url).origin;
    for (let attempt = 0; attempt < 50; attempt++) {
      const stateRes = await browser.cdp.send(
        'Runtime.evaluate',
        {
          expression: `({ ready: document.readyState, origin: window.location.origin })`,
          returnByValue: true,
        },
        sessionId
      );
      const val = (stateRes.result as { value?: { ready?: string; origin?: string } } | undefined)?.value;
      if (val?.ready === 'complete' && val?.origin === expectedOrigin) break;
      await new Promise((r) => setTimeout(r, 100));
    }

    const evalRes = await browser.cdp.send(
      'Runtime.evaluate',
      {
        expression,
        awaitPromise: true,
        returnByValue: true,
      },
      sessionId
    );

    if (evalRes.exceptionDetails) {
      throw new Error(`Browser page evaluation threw exception: ${JSON.stringify(evalRes.exceptionDetails)}`);
    }
    const resultObj = evalRes.result as { value?: T } | undefined;
    return resultObj?.value as T;
  } finally {
    await browser.cdp.send('Target.closeTarget', { targetId }).catch(() => undefined);
  }
}

function startSyntheticOriginServer(originLabel: string): Promise<{ server: http.Server; origin: string }> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      if (req.url === '/api/synthetic-financials') {
        // Deliberately NO Access-Control-Allow-Origin header to verify real browser SOP blocking.
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(
          JSON.stringify({
            synthetic: true,
            originLabel,
            buyPrice: 4250,
            costPerBaseUnitExact: '4250/10',
            grossProfit: 1750,
          })
        );
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(`<!doctype html><html><head><title>Khalid M-30 ${originLabel}</title></head><body><h1>M-30 Synthetic Origin ${originLabel}</h1></body></html>`);
    });
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        reject(new Error('Failed to bind synthetic HTTP origin'));
        return;
      }
      resolve({ server, origin: `http://127.0.0.1:${addr.port}` });
    });
  });
}

async function runM30BrowserSopE2E(): Promise<void> {
  const browserBin = findRealBrowserBinary();
  const originA = await startSyntheticOriginServer('ORIGIN_A_PHARMACY');
  const originB = await startSyntheticOriginServer('ORIGIN_B_UNTRUSTED');

  let profileA: LaunchedBrowser | null = null;
  let profileB: LaunchedBrowser | null = null;

  const passed: string[] = [];
  const DB_NAME = 'KhalidPharmacyM30SyntheticDB';
  const STORE_NAME = 'admin_financial_cache';
  const LS_KEY = 'khalid_m30_synthetic_admin_financials';
  const SYNTHETIC_SECRET_VALUE = JSON.stringify({
    synthetic: true,
    medicineId: 'med-synth-01',
    buyPrice: 4250,
    costPerBaseUnitExact: '4250/10',
    grossProfit: 1750,
    stocktakeSessionId: 'sess-synth-m30',
  });

  try {
    profileA = await launchRealChrome(browserBin, 'admin-profile-a');
    console.log(`[M-30] Real Browser Binary: ${browserBin}`);
    console.log(`[M-30] Real Browser Version: ${profileA.version}`);
    console.log(`[M-30] Origin A: ${originA.origin}`);
    console.log(`[M-30] Origin B: ${originB.origin}`);

    // -----------------------------------------------------------------------
    // M-30.1: Seed synthetic Admin financial data in real Browser IndexedDB & localStorage on Origin A
    // -----------------------------------------------------------------------
    const seedResult = await openTabAndEval<{ lsSaved: string | null; idbCount: number; idbBuyPrice: number }>(
      profileA,
      originA.origin,
      `(async () => {
        localStorage.setItem(${JSON.stringify(LS_KEY)}, ${JSON.stringify(SYNTHETIC_SECRET_VALUE)});
        const db = await new Promise((resolve, reject) => {
          const req = indexedDB.open(${JSON.stringify(DB_NAME)}, 1);
          req.onupgradeneeded = () => {
            if (!req.result.objectStoreNames.contains(${JSON.stringify(STORE_NAME)})) {
              req.result.createObjectStore(${JSON.stringify(STORE_NAME)}, { keyPath: 'id' });
            }
          };
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
        });
        await new Promise((resolve, reject) => {
          const tx = db.transaction(${JSON.stringify(STORE_NAME)}, 'readwrite');
          tx.objectStore(${JSON.stringify(STORE_NAME)}).put({
            id: 'fin-synth-1',
            buyPrice: 4250,
            costPerBaseUnitExact: '4250/10',
            grossProfit: 1750,
            synthetic: true
          });
          tx.oncomplete = () => resolve(true);
          tx.onerror = () => reject(tx.error);
        });
        const rows = await new Promise((resolve, reject) => {
          const tx = db.transaction(${JSON.stringify(STORE_NAME)}, 'readonly');
          const r = tx.objectStore(${JSON.stringify(STORE_NAME)}).getAll();
          r.onsuccess = () => resolve(r.result);
          r.onerror = () => reject(r.error);
        });
        db.close();
        return { lsSaved: localStorage.getItem(${JSON.stringify(LS_KEY)}), idbCount: rows.length, idbBuyPrice: rows[0]?.buyPrice ?? -1 };
      })()`
    );
    assert.equal(seedResult.lsSaved, SYNTHETIC_SECRET_VALUE, 'M-30.1 localStorage seed must persist on Origin A');
    assert.equal(seedResult.idbCount, 1, 'M-30.1 IndexedDB must hold 1 synthetic financial row on Origin A');
    assert.equal(seedResult.idbBuyPrice, 4250, 'M-30.1 IndexedDB row must preserve synthetic buyPrice on Origin A');
    passed.push('M-30.1');
    console.log('[PASS] M-30.1 — Origin A persisted synthetic Admin financial record in real Browser IndexedDB & localStorage');

    // -----------------------------------------------------------------------
    // M-30.2 & M-30.3: Cross-Origin localStorage & IndexedDB SOP Isolation on Origin B (SAME Chrome profile!)
    // -----------------------------------------------------------------------
    const crossOriginStorage = await openTabAndEval<{
      origin: string;
      lsLength: number;
      lsRead: string | null;
      dbNames: string[];
      idbRowsOnOriginB: number;
    }>(
      profileA,
      originB.origin,
      `(async () => {
        const lsLength = localStorage.length;
        const lsRead = localStorage.getItem(${JSON.stringify(LS_KEY)});
        const dbs = typeof indexedDB.databases === 'function' ? await indexedDB.databases() : [];
        const dbNames = dbs.map((d) => String(d.name || ''));
        const db = await new Promise((resolve, reject) => {
          const req = indexedDB.open(${JSON.stringify(DB_NAME)}, 1);
          req.onupgradeneeded = () => {
            if (!req.result.objectStoreNames.contains(${JSON.stringify(STORE_NAME)})) {
              req.result.createObjectStore(${JSON.stringify(STORE_NAME)}, { keyPath: 'id' });
            }
          };
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
        });
        const rows = await new Promise((resolve, reject) => {
          const tx = db.transaction(${JSON.stringify(STORE_NAME)}, 'readonly');
          const r = tx.objectStore(${JSON.stringify(STORE_NAME)}).getAll();
          r.onsuccess = () => resolve(r.result);
          r.onerror = () => reject(r.error);
        });
        db.close();
        return { origin: window.location.origin, lsLength, lsRead, dbNames, idbRowsOnOriginB: rows.length };
      })()`
    );
    assert.equal(crossOriginStorage.origin, originB.origin);
    assert.equal(crossOriginStorage.lsLength, 0, 'M-30.2 Origin B must have 0 localStorage keys from Origin A');
    assert.equal(crossOriginStorage.lsRead, null, 'M-30.2 Origin B must NOT read Origin A localStorage key');
    passed.push('M-30.2');
    console.log('[PASS] M-30.2 — Cross-origin localStorage strictly isolated by real Browser SOP (Origin B reads 0 keys)');

    assert.equal(
      crossOriginStorage.dbNames.includes(DB_NAME),
      false,
      'M-30.3 Origin B indexedDB.databases() must NOT list Origin A database prior to own open'
    );
    assert.equal(crossOriginStorage.idbRowsOnOriginB, 0, 'M-30.3 Origin B IndexedDB must contain 0 records from Origin A');
    passed.push('M-30.3');
    console.log('[PASS] M-30.3 — Cross-origin IndexedDB strictly isolated by real Browser SOP (Origin B sees 0 records)');

    // -----------------------------------------------------------------------
    // M-30.4: Cross-Origin iframe DOM & localStorage SOP Enforcement (SecurityError)
    // -----------------------------------------------------------------------
    const iframeResult = await openTabAndEval<{ domErrorName: string; lsErrorName: string }>(
      profileA,
      originB.origin,
      `(async () => {
        const frame = document.createElement('iframe');
        frame.src = ${JSON.stringify(originA.origin + '/')};
        await new Promise((resolve) => {
          frame.onload = () => resolve(true);
          document.body.appendChild(frame);
        });
        let domErrorName = 'NONE';
        let lsErrorName = 'NONE';
        try {
          const doc = frame.contentDocument;
          if (doc && doc.body) {
            domErrorName = 'LEAKED:' + doc.body.innerText;
          } else {
            // HTML spec: contentDocument returns null for cross-origin browsing context
            domErrorName = 'NULL_BLOCKED';
          }
        } catch (err) {
          domErrorName = String(err && err.name ? err.name : err);
        }
        try {
          void frame.contentWindow.localStorage.getItem(${JSON.stringify(LS_KEY)});
          lsErrorName = 'LEAKED';
        } catch (err) {
          lsErrorName = String(err && err.name ? err.name : err);
        }
        return { domErrorName, lsErrorName };
      })()`
    );
    assert.ok(
      iframeResult.domErrorName === 'SecurityError' || iframeResult.domErrorName === 'NULL_BLOCKED',
      `M-30.4 cross-origin iframe contentDocument must be blocked, got ${iframeResult.domErrorName}`
    );
    assert.equal(
      iframeResult.lsErrorName,
      'SecurityError',
      `M-30.4 cross-origin iframe.contentWindow.localStorage must throw SecurityError, got ${iframeResult.lsErrorName}`
    );
    passed.push('M-30.4');
    console.log('[PASS] M-30.4 — Cross-origin iframe DOM/localStorage access rejected by real Browser SOP (SecurityError)');

    // -----------------------------------------------------------------------
    // M-30.5: Cross-Origin fetch() without CORS blocked by Browser SOP
    // -----------------------------------------------------------------------
    const fetchResult = await openTabAndEval<{ blocked: boolean; errorName: string }>(
      profileA,
      originB.origin,
      `(async () => {
        try {
          const resp = await fetch(${JSON.stringify(originA.origin + '/api/synthetic-financials')});
          const text = await resp.text();
          return { blocked: false, errorName: 'LEAKED:' + text.slice(0, 60) };
        } catch (err) {
          return { blocked: true, errorName: String(err && err.name ? err.name : err) };
        }
      })()`
    );
    assert.equal(fetchResult.blocked, true, `M-30.5 cross-origin fetch must be blocked by SOP, got ${fetchResult.errorName}`);
    assert.equal(fetchResult.errorName, 'TypeError', 'M-30.5 blocked cross-origin fetch throws TypeError');
    passed.push('M-30.5');
    console.log('[PASS] M-30.5 — Cross-origin fetch() of synthetic financial endpoint blocked by real Browser SOP (TypeError)');

    // -----------------------------------------------------------------------
    // M-30.6: Same-Origin Same-Profile Residual Exposure Proof (R3.2 Negative Audit)
    // -----------------------------------------------------------------------
    const sameProfileRead = await openTabAndEval<{ lsLeaked: boolean; idbLeakedRows: number }>(
      profileA,
      originA.origin,
      `(async () => {
        const lsLeaked = localStorage.getItem(${JSON.stringify(LS_KEY)}) === ${JSON.stringify(SYNTHETIC_SECRET_VALUE)};
        const db = await new Promise((resolve, reject) => {
          const req = indexedDB.open(${JSON.stringify(DB_NAME)}, 1);
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
        });
        const rows = await new Promise((resolve, reject) => {
          const tx = db.transaction(${JSON.stringify(STORE_NAME)}, 'readonly');
          const r = tx.objectStore(${JSON.stringify(STORE_NAME)}).getAll();
          r.onsuccess = () => resolve(r.result);
          r.onerror = () => reject(r.error);
        });
        db.close();
        return { lsLeaked, idbLeakedRows: rows.length };
      })()`
    );
    assert.equal(sameProfileRead.lsLeaked, true, 'M-30.6 confirms same-origin same-profile localStorage remains readable across tabs');
    assert.equal(sameProfileRead.idbLeakedRows, 1, 'M-30.6 confirms same-origin same-profile IndexedDB remains readable without profile isolation/wipe');
    passed.push('M-30.6');
    console.log('[PASS] M-30.6 — Same-origin same-profile residual exposure empirically confirmed (proves R3.2 shared-device boundary)');

    // -----------------------------------------------------------------------
    // M-30.7: Separate Browser Profile Isolation (R3.2 Mitigation) + Explicit Logout Wipe Proof
    // -----------------------------------------------------------------------
    profileB = await launchRealChrome(browserBin, 'cashier-profile-b');
    const isolatedProfileRead = await openTabAndEval<{ lsLength: number; lsRead: string | null; dbNames: string[] }>(
      profileB,
      originA.origin,
      `(async () => {
        const dbs = typeof indexedDB.databases === 'function' ? await indexedDB.databases() : [];
        return {
          lsLength: localStorage.length,
          lsRead: localStorage.getItem(${JSON.stringify(LS_KEY)}),
          dbNames: dbs.map((d) => String(d.name || ''))
        };
      })()`
    );
    assert.equal(isolatedProfileRead.lsLength, 0, 'M-30.7a separate browser profile on Origin A must see 0 localStorage keys');
    assert.equal(isolatedProfileRead.lsRead, null, 'M-30.7a separate browser profile on Origin A must NOT read Admin localStorage');
    assert.equal(isolatedProfileRead.dbNames.length, 0, 'M-30.7a separate browser profile on Origin A must see 0 IndexedDB databases');

    // Explicit logout wipe in Profile A on Origin A
    const afterWipe = await openTabAndEval<{ lsLength: number; dbCount: number }>(
      profileA,
      originA.origin,
      `(async () => {
        localStorage.clear();
        await new Promise((resolve, reject) => {
          const del = indexedDB.deleteDatabase(${JSON.stringify(DB_NAME)});
          del.onsuccess = () => resolve(true);
          del.onerror = () => reject(del.error);
          del.onblocked = () => reject(new Error('deleteDatabase blocked'));
        });
        const dbs = typeof indexedDB.databases === 'function' ? await indexedDB.databases() : [];
        return { lsLength: localStorage.length, dbCount: dbs.length };
      })()`
    );
    assert.equal(afterWipe.lsLength, 0, 'M-30.7b explicit wipe must clear Origin A localStorage');
    assert.equal(afterWipe.dbCount, 0, 'M-30.7b explicit wipe must delete Origin A IndexedDB database');
    passed.push('M-30.7');
    console.log('[PASS] M-30.7 — Separate Chrome profile completely isolates Origin A storage (0 keys / 0 DBs) & explicit wipe clears all residual records');

    console.log('========================================================================');
    console.log(`[PASS] M-30 — Real Browser E2E SOP / IndexedDB / LocalStorage Isolation: ${passed.length}/7 PASSED, 0 FAILED`);
    console.log('========================================================================');
  } finally {
    if (profileB) await profileB.close();
    if (profileA) await profileA.close();
    originB.server.close();
    originA.server.close();
  }
}

runM30BrowserSopE2E().catch((err) => {
  console.error('[FAIL] M-30 Real Browser E2E failed:', err);
  process.exit(1);
});
