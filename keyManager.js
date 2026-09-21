// State tracking for API keys:
// 1. Key exhaustion tracking: Map of key -> { exhaustedUntil: number, reason: string }
// 2. Active key index tracking: Map of keySetFingerprint -> number (sticky active index)
// meow :3

const exhaustedKeys = new Map();
const activeKeyIndices = new Map();
const MAX_CACHE_ENTRIES = 500;

function cleanupCache(map) {
  if (map.size > MAX_CACHE_ENTRIES) {
    const now = Date.now();
    for (const [key, value] of map.entries()) {
      if (typeof value === 'object' && value.exhaustedUntil && value.exhaustedUntil <= now) {
        map.delete(key);
      }
    }
    if (map.size > MAX_CACHE_ENTRIES) {
      const keysToDelete = Array.from(map.keys()).slice(0, 100);
      for (const k of keysToDelete) map.delete(k);
    }
  }
}

export function getKeySetId(keys) {
  return Array.isArray(keys) ? keys.join('::') : String(keys);
}

// Parses comma-separated keys into an array, trimming whitespace and ignoring blanks.
// Supports any key format: legacy AIza..., new AQ... / AQ.Ab..., etc.
export function parseApiKeys(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) {
    return raw.flatMap(parseApiKeys);
  }
  return String(raw)
    .split(',')
    .map((k) => k.trim())
    .filter(Boolean);
}

// Safely masks keys for Railway log inspection (e.g. AQ.A...1234 or AIza...5678)
export function maskKey(key) {
  if (!key || typeof key !== 'string') return 'none';
  const trimmed = key.trim();
  if (trimmed.length <= 8) return '****';
  return `${trimmed.slice(0, 4)}...${trimmed.slice(-4)}`;
}

// Detects whether an upstream Gemini error is due to key/quota/rate exhaustion
export function isKeyExhaustionError(status, parsedError, rawText = '') {
  if (status === 429) return true;

  const errStatus = parsedError?.status;
  if (errStatus === 'RESOURCE_EXHAUSTED' || errStatus === 'UNAUTHENTICATED') {
    return true;
  }

  const message = (parsedError?.message || rawText || '').toLowerCase();
  if (
    message.includes('quota') ||
    message.includes('rate limit') ||
    message.includes('rate_limit') ||
    message.includes('resource has been exhausted') ||
    message.includes('resource_exhausted') ||
    message.includes('api key not valid') ||
    message.includes('api_key_invalid') ||
    message.includes('api key expired')
  ) {
    return true;
  }

  if (status === 403 && (message.includes('quota') || message.includes('suspend') || message.includes('disabled'))) {
    return true;
  }

  return false;
}

// Resolves candidate keys in priority order:
// Starts from the current active key, prioritizes non-exhausted keys,
// and falls back to cooling-down keys ordered by earliest expiration.
export function getCandidateKeys(keys) {
  if (!Array.isArray(keys) || keys.length === 0) return [];
  if (keys.length === 1) return [...keys];

  const now = Date.now();
  const keySetId = getKeySetId(keys);
  let activeIdx = activeKeyIndices.get(keySetId) ?? 0;
  if (activeIdx < 0 || activeIdx >= keys.length) activeIdx = 0;

  const rotated = [];
  for (let i = 0; i < keys.length; i++) {
    rotated.push(keys[(activeIdx + i) % keys.length]);
  }

  const available = [];
  const coolingDown = [];

  for (const key of rotated) {
    const record = exhaustedKeys.get(key);
    if (!record || record.exhaustedUntil <= now) {
      available.push(key);
    } else {
      coolingDown.push({ key, exhaustedUntil: record.exhaustedUntil });
    }
  }

  coolingDown.sort((a, b) => a.exhaustedUntil - b.exhaustedUntil);

  return [...available, ...coolingDown.map((c) => c.key)];
}

// Marks a key as exhausted and advances the active pointer to the next key
export function markKeyExhausted(key, cooldownMs = 60_000, reason = '', keyList = []) {
  if (!key) return;
  const now = Date.now();
  exhaustedKeys.set(key, {
    exhaustedUntil: now + Math.max(1000, cooldownMs),
    reason,
  });
  cleanupCache(exhaustedKeys);

  if (Array.isArray(keyList) && keyList.length > 1) {
    const keySetId = getKeySetId(keyList);
    const currentIdx = keyList.indexOf(key);
    if (currentIdx !== -1) {
      const nextIdx = (currentIdx + 1) % keyList.length;
      activeKeyIndices.set(keySetId, nextIdx);
      cleanupCache(activeKeyIndices);
    }
  }
}

// Marks a key as working; clears any exhaustion state and locks active index on it
export function markKeySuccess(key, keyList = []) {
  if (!key) return;
  exhaustedKeys.delete(key);

  if (Array.isArray(keyList) && keyList.length > 1) {
    const keySetId = getKeySetId(keyList);
    const idx = keyList.indexOf(key);
    if (idx !== -1) {
      activeKeyIndices.set(keySetId, idx);
      cleanupCache(activeKeyIndices);
    }
  }
}

export function resetKeyState() {
  exhaustedKeys.clear();
  activeKeyIndices.clear();
}
