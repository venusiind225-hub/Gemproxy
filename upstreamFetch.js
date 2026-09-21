// Retries a fetch when Gemini returns a *transient* error — 500/503
// (overloaded — very common on the free tier) or 504.
// Never retries on other statuses (400/401/404/etc — retrying those just
// wastes time, the response won't change) and never retries after a
// network-level AbortError (the caller's own timeout firing).

// Only ever wraps the INITIAL request. For streaming calls that means only
// the connection attempt is retried — once bytes are already flowing to
// the client we obviously stop and just relay what Gemini sends.
const RETRYABLE_STATUS = new Set([429, 500, 503, 504]);

export async function fetchWithRetry(url, init, { attempts, baseDelayMs } = {}) {
  const maxAttempts = Math.max(1, attempts ?? 3);
  const delayMs = baseDelayMs ?? 500;

  let lastResponse;
  let lastError;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const isLastAttempt = attempt === maxAttempts - 1;

    try {
      const response = await fetch(url, init);

      if (response.ok || !RETRYABLE_STATUS.has(response.status) || isLastAttempt) {
        return response;
      }

      // Drain the failed response's body so Node doesn't warn about an
      // abandoned stream, then fall through to retry.
      await response.body?.cancel().catch(() => {});
      lastResponse = response;
    } catch (err) {
      if (err.name === 'AbortError' || isLastAttempt) throw err;
      lastError = err;
    }

    // Exponential backoff with a little jitter so several requests that
    // all get rate-limited at once don't retry in lockstep.
    const backoff = delayMs * 2 ** attempt + Math.floor(Math.random() * 200);
    await new Promise((resolve) => setTimeout(resolve, backoff));
  }

  // Unreachable in practice (the loop always returns or throws on the
  // last attempt), but keeps the function's return type honest.
  if (lastResponse) return lastResponse;
  throw lastError;
}
