import 'dotenv/config';

function optionalNumber(name) {
  return process.env[name] !== undefined ? Number(process.env[name]) : undefined;
}

export const config = {
  port: process.env.PORT || 8080,
  nodeEnv: process.env.NODE_ENV || 'production',

  // --- API key handling ------------------------------------------------
  geminiApiKey: process.env.GEMINI_API_KEY || undefined,
  proxyApiKey: process.env.PROXY_API_KEY || undefined,
  geminiBaseUrl: process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com',

  // Cooldown time (in ms) when an API key hits a quota or rate limit (429).
  // Defaults to 60,000ms (1 minute).
  keyCooldownMs: Number(process.env.KEY_COOLDOWN_MS || 60_000),

  // Per-category Gemini safety thresholds.
  safetyThresholds: {
    harassment: 'BLOCK_NONE',
    hateSpeech: 'BLOCK_NONE',
    sexuallyExplicit: 'BLOCK_NONE',
    dangerousContent: 'BLOCK_NONE',
  },

  allowedOrigins: (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  rateLimitWindowMs: Number(process.env.RATE_LIMIT_WINDOW_MS || 60_000),
  rateLimitMax: Number(process.env.RATE_LIMIT_MAX || 180),

  requestTimeoutMs: Number(process.env.REQUEST_TIMEOUT_MS || 600_000),

  retryAttempts: Number(process.env.RETRY_ATTEMPTS || 1),
  retryBaseDelayMs: Number(process.env.RETRY_BASE_DELAY_MS || 500),

  defaultTemperature: optionalNumber('DEFAULT_TEMPERATURE'),
  defaultTopP: optionalNumber('DEFAULT_TOP_P'),
  defaultMaxTokens: optionalNumber('DEFAULT_MAX_TOKENS') ?? 12000,
  maxTokensCap: optionalNumber('MAX_TOKENS_CAP'),

  enableThinking: process.env.ENABLE_THINKING === 'true',
  reasoningEffort: process.env.REASONING_EFFORT,
  showReasoning: process.env.SHOW_REASONING === 'true',

  enablePrefill: process.env.ENABLE_PREFILL === 'true',
  enableOocTrick: process.env.ENABLE_OOC_TRICK === 'true',
  enableBrailleTrick: process.env.ENABLE_BRAILLE_TRICK === 'true',
  enableNoAss: process.env.ENABLE_NOASS === 'true',
  enableGoogleSearch: process.env.ENABLE_GOOGLE_SEARCH === 'true',
};
