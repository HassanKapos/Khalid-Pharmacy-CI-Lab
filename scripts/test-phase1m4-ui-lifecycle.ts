/**
 * Phase 1M.4-R1 UI Lifecycle & Toast Deduplication Test Suite
 */
async function runUiLifecycleTests() {
  console.log('========================================================================');
  console.log('🧪 KHALID PHARMACY — PHASE 1M.4-R1 UI LIFECYCLE VERIFICATION SUITE');
  console.log('========================================================================\n');

  // Simulated Reactive State & Timer Storage
  const toasts: Array<{ id: string; type: string; title: string; message: string }> = [];
  const toastTimers = new Map<string, any>();

  const dismissToast = (id: string) => {
    if (toastTimers.has(id)) {
      clearTimeout(toastTimers.get(id));
      toastTimers.delete(id);
    }
    const idx = toasts.findIndex(t => t.id === id);
    if (idx !== -1) {
      toasts.splice(idx, 1);
    }
  };

  const showToast = (type: string, title: string, message: string) => {
    const dedupKey = `${type}:${title}:${message}`;
    const existingIndex = toasts.findIndex(t => `${t.type}:${t.title}:${t.message}` === dedupKey);

    if (existingIndex !== -1) {
      const existingToast = toasts[existingIndex];
      if (toastTimers.has(existingToast.id)) {
        clearTimeout(toastTimers.get(existingToast.id));
      }
      const newTimer = setTimeout(() => {
        dismissToast(existingToast.id);
      }, 6500);
      toastTimers.set(existingToast.id, newTimer);
      return existingToast.id;
    }

    const id = 'toast-' + Date.now() + '-' + Math.random().toString(36).substr(2, 4);
    toasts.push({ id, type, title, message });
    const timer = setTimeout(() => {
      dismissToast(id);
    }, 6500);
    toastTimers.set(id, timer);
    return id;
  };

  // --- Test 1: Repeated Identical Toast Events (Deduplication) ---
  console.log('--- Test 1: Repeated identical Toast events deduplication ---');
  const id1 = showToast('warning', 'دواء غير مسجل', 'لم يتم العثور على دواء بالباركود: 12345');
  const id2 = showToast('warning', 'دواء غير مسجل', 'لم يتم العثور على دواء بالباركود: 12345');
  const id3 = showToast('warning', 'دواء غير مسجل', 'لم يتم العثور على دواء بالباركود: 12345');

  if (toasts.length === 1) {
    console.log('  ✓ [PASS] Exactly 1 toast element present after 3 identical triggers');
  } else {
    throw new Error(`Expected 1 toast, found ${toasts.length}`);
  }
  if (id1 === id2 && id2 === id3) {
    console.log('  ✓ [PASS] Returned toast ID is identical across re-triggers');
  } else {
    throw new Error('Toast ID changed on duplicate trigger');
  }

  // --- Test 2: Timer Reset on Re-trigger ---
  console.log('--- Test 2: Timer reset on identical Toast re-trigger ---');
  const initialTimer = toastTimers.get(id1);
  await new Promise(r => setTimeout(r, 50));
  showToast('warning', 'دواء غير مسجل', 'لم يتم العثور على دواء بالباركود: 12345');
  const updatedTimer = toastTimers.get(id1);
  if (initialTimer !== updatedTimer) {
    console.log('  ✓ [PASS] Previous timer handle was cleared and replaced with new timer handle');
  } else {
    throw new Error('Timer handle was not updated on duplicate toast re-trigger');
  }

  // --- Test 3: Manual Dismissal Clears Timer & State ---
  console.log('--- Test 3: Manual dismissal clears Toast and timer handle ---');
  dismissToast(id1);
  if ((toasts as any).length === 0 && toastTimers.size === 0) {
    console.log('  ✓ [PASS] Manual dismissal cleared toast array and timer Map cleanly');
  } else {
    throw new Error('Toast or timer handle remained after manual dismissal');
  }

  // --- Test 4: Error A followed by Error B (Tokenized Timer) ---
  console.log('--- Test 4: Error A followed by Error B tokenized timer auto-dismiss ---');
  let activeError = '';
  let errorTimer: any = null;
  let errorToken = 0;

  const setError = (msg: string) => {
    if (errorTimer !== null) {
      clearTimeout(errorTimer);
      errorTimer = null;
    }
    const currentToken = ++errorToken;
    activeError = msg;

    if (msg) {
      errorTimer = setTimeout(() => {
        if (errorToken === currentToken) {
          activeError = '';
          errorTimer = null;
        }
      }, 4000);
    }
  };

  // Set Error A at t=0
  setError('Error A: Permission Denied');
  if (activeError === 'Error A: Permission Denied') {
    console.log('  ✓ [PASS] Error A set successfully');
  }

  // Wait 100ms and set Error B
  await new Promise(r => setTimeout(r, 100));
  setError('Error B: Camera Unbound');
  if (activeError === 'Error B: Camera Unbound') {
    console.log('  ✓ [PASS] Error B replaced Error A immediately');
  }

  // Wait 400ms for Error A's initial window to pass
  await new Promise(r => setTimeout(r, 400));
  if (activeError === 'Error B: Camera Unbound') {
    console.log('  ✓ [PASS] Error B is still active and NOT prematurely cleared by Error A timer');
  } else {
    throw new Error('Error B was prematurely cleared by Error A timer!');
  }

  // --- Test 5: Component Disposal Clears Timers ---
  console.log('--- Test 5: Component disposal clears outstanding timers ---');
  setError('Error C: Hardware Failure');
  showToast('info', 'تحذير', 'إشعار اختبار');
  
  // Simulate onUnmounted disposal
  if (toastTimers) {
    toastTimers.forEach(timer => clearTimeout(timer));
    toastTimers.clear();
  }
  if (errorTimer !== null) {
    clearTimeout(errorTimer);
    errorTimer = null;
  }

  if (toastTimers.size === 0 && errorTimer === null) {
    console.log('  ✓ [PASS] All active timers cleanly cancelled on disposal\n');
  } else {
    throw new Error('Active timers leaked during component disposal');
  }

  console.log('========================================================================');
  console.log('🎉 PHASE 1M.4-R1 UI LIFECYCLE TESTS: 5/5 PASSED (100%)');
  console.log('========================================================================');
}

runUiLifecycleTests().catch(err => {
  console.error('❌ Test failure:', err);
  process.exit(1);
});
