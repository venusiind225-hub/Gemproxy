import rateLimit from 'express-rate-limit';
import { config } from '../config.js';

// Per-IP rate limit. This doesn't raise your Gemini quota — it just stops
// a bug, bot, or leaked URL from burning through your whole daily quota
// in seconds.
export const rateLimiter = rateLimit({
  windowMs: config.rateLimitWindowMs,
  max: config.rateLimitMax,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Rate limit exceeded on the proxy. Slow down to protect your Gemini quota.' },
});
