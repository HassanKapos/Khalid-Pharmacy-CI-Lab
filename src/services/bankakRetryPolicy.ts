/**
 * Durable retry timing policy for the Bankak OCR background queue.
 * Two automatic retries are allowed; each delay grows exponentially and adds
 * bounded jitter to avoid synchronized retry storms.
 */
export const BANKAK_MAX_AUTO_RETRIES = 2;
export const BANKAK_RETRY_BASE_DELAY_MS = 2_000;
export const BANKAK_RETRY_MAX_DELAY_MS = 15_000;
export const BANKAK_RETRY_JITTER_MS = 1_000;

export function getBankakRetryDelayMs(retryCount: number, randomValue = Math.random()): number {
  if (!Number.isInteger(retryCount) || retryCount < 1) {
    throw new RangeError('retryCount must be a positive integer');
  }
  if (!Number.isFinite(randomValue)) {
    throw new RangeError('randomValue must be finite');
  }

  const exponent = Math.min(retryCount - 1, 5);
  const exponentialDelay = Math.min(
    BANKAK_RETRY_MAX_DELAY_MS,
    BANKAK_RETRY_BASE_DELAY_MS * (2 ** exponent)
  );
  const normalizedRandom = Math.min(0.999999, Math.max(0, randomValue));
  const jitter = Math.floor(normalizedRandom * BANKAK_RETRY_JITTER_MS);
  return exponentialDelay + jitter;
}
