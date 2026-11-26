/**
 * Web Worker for Bankak Asynchronous Background Processing & Optimized Adaptive Polling
 * Runs in a dedicated background thread off the main UI execution.
 *
 * Security Architecture (Phase 2D AUTH-R4):
 * - The main application thread owns all authenticated HTTP requests via window.apiClient.
 * - This Worker NEVER receives, stores, logs, or requests Firebase ID Tokens.
 * - The Worker strictly manages adaptive polling cadence, backoff, abort epochs, and status diffing,
 *   delegating authenticated /api/bankak/receipts fetches to the main thread via POLL_REQUEST / POLL_RESPONSE.
 *
 * Optimized Polling Schedule (Phase 3-A.2):
 * - Active processing: 3,000ms (3s) with jitter when any receipt is in 'Pending' or 'Processing'
 * - Idle state: 30,000ms (30s) with jitter when all receipts are completed/reviewed/duplicate
 * - Application background (minimized/hidden): Periodic polling stopped completely
 * - Network unavailable / error: Bounded exponential backoff (5s, 10s, 20s, 40s, 60s max)
 * - Network restored / Foreground resume: Instantaneous single synchronization & timer reset
 * - Overlap prevention: Single in-flight request guarantee with AbortController
 */

const ACTIVE_INTERVAL = 3000;  // 3s for active processing
const IDLE_INTERVAL = 30000;   // 30s for idle state
const BACKOFF_STEPS = [5000, 10000, 20000, 40000, 60000]; // 5s, 10s, 20s, 40s, 60s max
const MAX_BACKOFF_RETRIES = 10; // Bounded retry cap for transient 5xx / offline errors
const BRIDGE_TIMEOUT_MS = 45000; // Detect main-thread / bridge stalls cleanly

let pollTimer = null;
let lastKnownStatuses = new Map();
let isPolling = false;
let isStarted = false;
let isPaused = false;
let isConfigured = false;
let apiBaseUrl = '';
let currentBranchId = '';
let consecutiveFailures = 0;
let currentInterval = IDLE_INTERVAL;
let currentMode = 'IDLE'; // 'ACTIVE' | 'IDLE' | 'BACKOFF' | 'PAUSED' | 'STOPPED'
let currentAbortController = null;
let pollEpoch = 0;
let requestSeq = 0;
let activePollToken = 0;
let activeRequestId = null;
let pendingPollResolver = null;
let pendingPollRejecter = null;
let pendingBridgeTimer = null;

/**
 * Applies a random jitter (±10%) to prevent simultaneous server stampedes
 * from multiple active tablets / clients.
 */
function applyJitter(baseMs, percentage = 0.1) {
  const delta = baseMs * percentage;
  const offset = (Math.random() * 2 - 1) * delta;
  return Math.max(1000, Math.round(baseMs + offset));
}

function clearPendingPollBridge(abortReason) {
  if (pendingBridgeTimer) {
    clearTimeout(pendingBridgeTimer);
    pendingBridgeTimer = null;
  }
  activeRequestId = null;
  if (pendingPollRejecter && abortReason) {
    const rejectFn = pendingPollRejecter;
    pendingPollResolver = null;
    pendingPollRejecter = null;
    rejectFn(abortReason);
  } else {
    pendingPollResolver = null;
    pendingPollRejecter = null;
  }
}

function cancelInFlightPoll(reasonMessage = 'Poll aborted') {
  if (currentAbortController) {
    try {
      currentAbortController.abort();
    } catch {
      // safe ignore
    }
  }
  const abortErr = new Error(reasonMessage);
  abortErr.name = 'AbortError';
  clearPendingPollBridge(abortErr);
}

/**
 * Requests an authenticated receipt fetch from the main thread (which uses window.apiClient).
 * Zero tokens ever cross into the Worker boundary.
 */
function requestMainThreadPoll(branchId, signal) {
  requestSeq += 1;
  const requestId = `${pollEpoch}:${requestSeq}`;
  activeRequestId = requestId;

  return new Promise((resolve, reject) => {
    pendingPollResolver = resolve;
    pendingPollRejecter = reject;

    if (signal) {
      if (signal.aborted) {
        const abortErr = new Error('Poll aborted');
        abortErr.name = 'AbortError';
        clearPendingPollBridge(abortErr);
        return;
      }
      signal.addEventListener(
        'abort',
        () => {
          const abortErr = new Error('Poll aborted');
          abortErr.name = 'AbortError';
          clearPendingPollBridge(abortErr);
        },
        { once: true }
      );
    }

    pendingBridgeTimer = setTimeout(() => {
      if (activeRequestId === requestId) {
        const timeoutErr = new Error('انتهت مهلة انتظار استجابة مزامنة بنكك من التطبيق');
        timeoutErr.code = 'WORKER_FAILURE';
        clearPendingPollBridge(timeoutErr);
      }
    }, BRIDGE_TIMEOUT_MS);

    self.postMessage({
      type: 'POLL_REQUEST',
      requestId,
      branchId,
      epoch: pollEpoch
    });
  });
}

/**
 * Schedules the next poll using setTimeout to guarantee zero overlapping requests.
 */
function scheduleNextPoll(delayMs) {
  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
  if (!isStarted || isPaused) return;

  const jitteredDelay = applyJitter(delayMs);
  pollTimer = setTimeout(() => {
    checkReceipts(false);
  }, jitteredDelay);
}

/**
 * Main polling task: coordinates authenticated main-thread fetch, detects status transitions,
 * and adapts polling cadence with bounded backoff and fatal auth stopping.
 */
async function checkReceipts(isImmediate = false) {
  // Overlap and gating guard
  if (isPolling || !isConfigured) return;
  if (!currentBranchId) return;
  if (!isStarted && !isImmediate) return;
  if (isPaused && !isImmediate) return;

  const targetBranchId = currentBranchId;
  const startEpoch = pollEpoch;
  const myPollToken = ++activePollToken;
  isPolling = true;

  // Prepare abort controller for cancellation
  if (currentAbortController) {
    try {
      currentAbortController.abort();
    } catch {
      // safe ignore
    }
  }
  currentAbortController = typeof AbortController !== 'undefined' ? new AbortController() : null;

  try {
    const data = await requestMainThreadPoll(
      targetBranchId,
      currentAbortController ? currentAbortController.signal : undefined
    );

    // Discard stale responses after branch switch or stop/logout
    if (startEpoch !== pollEpoch || targetBranchId !== currentBranchId) {
      return;
    }

    if (data && data.skipped) {
      // Main thread declined poll due to missing auth/branch/offline prerequisite
      if (data.authFatal) {
        isStarted = false;
        isPaused = true;
        if (pollTimer) {
          clearTimeout(pollTimer);
          pollTimer = null;
        }
        currentMode = 'STOPPED';
        self.postMessage({
          type: 'SYNC_ERROR',
          error: data.error || 'التحقق من الجلسة أو الفرع غير مكتمل',
          code: data.code || 'AUTH_TOKEN_REQUIRED',
          status: data.status || 401,
          fatal: true,
          stopped: true,
          branchId: targetBranchId,
          consecutiveFailures,
          currentMode
        });
        return;
      }
    }

    if (data && data.success === true && data.offline !== true && Array.isArray(data.receipts)) {
      // Reset backoff counter on successful response
      consecutiveFailures = 0;

      const currentList = data.receipts;
      const statusChanges = [];
      let hasActiveTasks = false;
      let activeCount = 0;

      currentList.forEach((r) => {
        if (r.status === 'Pending' || r.status === 'Processing') {
          hasActiveTasks = true;
          activeCount++;
        }

        const oldStatus = lastKnownStatuses.get(r.id);
        if (oldStatus && oldStatus !== r.status) {
          statusChanges.push({
            receipt: r,
            oldStatus,
            newStatus: r.status,
          });
        }
        lastKnownStatuses.set(r.id, r.status);
      });

      // Adaptive cadence: 3s when active, 30s when idle
      currentMode = hasActiveTasks ? 'ACTIVE' : 'IDLE';
      currentInterval = hasActiveTasks ? ACTIVE_INTERVAL : IDLE_INTERVAL;

      // Broadcast update to main thread
      self.postMessage({
        type: 'SYNC_UPDATE',
        branchId: targetBranchId,
        receipts: currentList,
        queueStats: data.queueStats,
        statusChanges,
        currentInterval,
        currentMode,
        activeCount,
      });

      // Schedule next poll only if still active and not paused
      if (isStarted && !isPaused) {
        scheduleNextPoll(currentInterval);
      }
    } else if (data && (data.authFatal === true || data.status === 403 || data.status === 401)) {
      // Fatal auth / authorization failure: STOP immediately, never exponential-backoff retry
      isStarted = false;
      isPaused = true;
      if (pollTimer) {
        clearTimeout(pollTimer);
        pollTimer = null;
      }
      currentMode = 'STOPPED';
      self.postMessage({
        type: 'SYNC_ERROR',
        error: data.error || `HTTP ${data.status || 401}`,
        code: data.code || (data.status === 403 ? 'CROSS_BRANCH_FORBIDDEN' : 'AUTH_TOKEN_REQUIRED'),
        status: data.status || 401,
        fatal: true,
        stopped: true,
        branchId: targetBranchId,
        consecutiveFailures,
        currentMode
      });
    } else {
      const errMsg = (data && data.error) ? data.error : 'Malformed receipt response payload';
      const errObj = new Error(errMsg);
      errObj.status = data?.status ?? 0;
      errObj.code = data?.code ?? (data?.offline ? 'OFFLINE' : 'SYNC_FAILED');
      errObj.offline = Boolean(data?.offline);
      throw errObj;
    }
  } catch (err) {
    if (err && (err.name === 'AbortError' || err.message?.includes('aborted'))) {
      return; // Intentional abort, do not trigger error backoff
    }

    if (err && (err.authFatal === true || err.status === 403 || err.status === 401)) {
      isStarted = false;
      isPaused = true;
      if (pollTimer) {
        clearTimeout(pollTimer);
        pollTimer = null;
      }
      currentMode = 'STOPPED';
      self.postMessage({
        type: 'SYNC_ERROR',
        error: err instanceof Error ? err.message : String(err),
        code: err.code || (err.status === 403 ? 'CROSS_BRANCH_FORBIDDEN' : 'AUTH_TOKEN_REQUIRED'),
        status: err.status || 401,
        fatal: true,
        stopped: true,
        branchId: targetBranchId,
        consecutiveFailures,
        currentMode
      });
      return;
    }

    consecutiveFailures++;
    // Bounded exponential backoff: 5s, 10s, 20s, 40s, 60s max
    const stepIdx = Math.min(consecutiveFailures - 1, BACKOFF_STEPS.length - 1);
    const backoffInterval = BACKOFF_STEPS[stepIdx];
    const retryCapReached = consecutiveFailures > MAX_BACKOFF_RETRIES;

    currentMode = 'BACKOFF';
    currentInterval = backoffInterval;
    if (retryCapReached) {
      currentMode = 'PAUSED';
      isPaused = true;
      if (pollTimer) {
        clearTimeout(pollTimer);
        pollTimer = null;
      }
    }

    self.postMessage({
      type: 'SYNC_ERROR',
      error: err instanceof Error ? err.message : String(err),
      code: err?.code || 'SYNC_ERROR',
      status: typeof err?.status === 'number' ? err.status : 0,
      offline: Boolean(err?.offline),
      fatal: false,
      stopped: retryCapReached,
      branchId: targetBranchId,
      consecutiveFailures,
      nextRetryMs: retryCapReached ? null : backoffInterval,
      currentMode
    });

    if (!retryCapReached && isStarted && !isPaused) {
      scheduleNextPoll(backoffInterval);
    }
  } finally {
    if (activePollToken === myPollToken) {
      isPolling = false;
      currentAbortController = null;
    }
  }
}

/**
 * Message handler: supports full lifecycle control (CONFIG, SET_BRANCH, POLL_RESPONSE, START, PAUSE, RESUME, ONLINE, TASK_ENQUEUED, STOP).
 */
self.onmessage = function (e) {
  const payload = e.data || {};
  const { type, apiBaseUrl: newApiBaseUrl } = payload;

  if (type === 'CONFIG') {
    apiBaseUrl = typeof newApiBaseUrl === 'string' ? newApiBaseUrl.trim() : '';
    if (typeof payload.branchId === 'string' && payload.branchId.trim()) {
      const nextBranch = payload.branchId.trim();
      if (nextBranch !== currentBranchId) {
        currentBranchId = nextBranch;
        lastKnownStatuses.clear();
      }
    }
    isConfigured = true;
    self.postMessage({ type: 'CONFIG_APPLIED', apiBaseUrl, branchId: currentBranchId });
    if (isStarted && !isPaused && currentBranchId) {
      checkReceipts(true);
    }
    return;
  }

  if (type === 'SET_BRANCH') {
    const nextBranch = typeof payload.branchId === 'string' ? payload.branchId.trim() : '';
    if (nextBranch !== currentBranchId) {
      pollEpoch += 1;
      cancelInFlightPoll('Branch switched');
      if (pollTimer) {
        clearTimeout(pollTimer);
        pollTimer = null;
      }
      lastKnownStatuses.clear();
      consecutiveFailures = 0;
      currentBranchId = nextBranch;
      isPolling = false;
    }
    self.postMessage({ type: 'BRANCH_APPLIED', branchId: currentBranchId });
    if (isStarted && !isPaused && isConfigured && currentBranchId) {
      checkReceipts(true);
    }
    return;
  }

  if (type === 'POLL_RESPONSE') {
    if (!activeRequestId || payload.requestId !== activeRequestId) {
      return; // Ignore stale or already-cancelled poll response
    }
    const resolveFn = pendingPollResolver;
    clearPendingPollBridge(null);
    if (typeof resolveFn === 'function') {
      resolveFn(payload);
    }
    return;
  }

  if (type === 'START_POLLING') {
    if (typeof payload.branchId === 'string' && payload.branchId.trim()) {
      const nextBranch = payload.branchId.trim();
      if (nextBranch !== currentBranchId) {
        lastKnownStatuses.clear();
        currentBranchId = nextBranch;
      }
    }
    isStarted = true;
    isPaused = false;
    consecutiveFailures = 0;
    self.postMessage({ type: 'POLLER_STARTED', interval: currentInterval, isConfigured, branchId: currentBranchId });
    if (isConfigured && currentBranchId) {
      checkReceipts(true);
    }
    return;
  }

  if (type === 'PAUSE_POLLING' || type === 'APP_BACKGROUND') {
    // App went into background or screen locked: stop periodic polling to preserve battery & data
    isPaused = true;
    if (pollTimer) {
      clearTimeout(pollTimer);
      pollTimer = null;
    }
    currentMode = 'PAUSED';
    self.postMessage({ type: 'POLLER_PAUSED' });
    return;
  }

  if (type === 'RESUME_POLLING' || type === 'APP_FOREGROUND') {
    // App returned to foreground: execute one immediate sync and resume scheduled cadence
    isPaused = false;
    isStarted = true;
    consecutiveFailures = 0;
    self.postMessage({ type: 'POLLER_RESUMED' });
    if (isConfigured && currentBranchId) {
      checkReceipts(true);
    }
    return;
  }

  if (type === 'NETWORK_ONLINE') {
    // Network connectivity recovered: reset failure backoff and trigger immediate sync
    consecutiveFailures = 0;
    if (isStarted) {
      isPaused = false;
    }
    self.postMessage({ type: 'NETWORK_RESTORED' });
    if (isConfigured && isStarted && !isPaused && currentBranchId) {
      checkReceipts(true);
    }
    return;
  }

  if (type === 'POLL_NOW' || type === 'TASK_ENQUEUED') {
    // A receipt was uploaded or retried: switch immediately to fast active polling (3s)
    currentMode = 'ACTIVE';
    currentInterval = ACTIVE_INTERVAL;
    consecutiveFailures = 0;
    if (isStarted) {
      isPaused = false;
    }
    if (pollTimer) {
      clearTimeout(pollTimer);
      pollTimer = null;
    }
    if (isConfigured && !isPaused && currentBranchId) {
      checkReceipts(true);
    }
    return;
  }

  if (type === 'STOP_POLLING') {
    pollEpoch += 1;
    isStarted = false;
    isPaused = true;
    currentMode = 'STOPPED';
    if (pollTimer) {
      clearTimeout(pollTimer);
      pollTimer = null;
    }
    cancelInFlightPoll('Polling stopped');
    isPolling = false;
    self.postMessage({ type: 'POLLER_STOPPED' });
    return;
  }
};
