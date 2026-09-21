import { config } from '../config.js';
import { parseApiKeys } from '../lib/keyManager.js';

function extractProvidedKey(req) {
  const authHeader = req.headers['authorization'] || '';
  const bearerMatch = authHeader.match(/^Bearer\s+(.+)$/i);
  if (bearerMatch) return bearerMatch[1].trim();

  if (req.headers['x-goog-api-key']) return String(req.headers['x-goog-api-key']).trim();
  if (req.headers['x-proxy-key']) return String(req.headers['x-proxy-key']).trim();
  if (typeof req.query?.key === 'string' && req.query.key) return req.query.key.trim();

  return '';
}

export function resolveApiKey(req, res, next, cfg = config) {
  const provided = extractProvidedKey(req);

  // 1. Password mode: PROXY_API_KEY matches
  if (cfg.proxyApiKey && provided === cfg.proxyApiKey) {
    if (!cfg.geminiApiKey) {
      return res.status(500).json({
        error: 'PROXY_API_KEY is set but GEMINI_API_KEY is not, so there is no real key to substitute in.',
      });
    }
    const keys = parseApiKeys(cfg.geminiApiKey);
    req.geminiApiKeys = keys;
    req.geminiApiKey = keys[0];
    return next();
  }

  // 2. Client-provided key(s)
  if (provided) {
    const keys = parseApiKeys(provided);
    req.geminiApiKeys = keys;
    req.geminiApiKey = keys[0];
    return next();
  }

  // 3. Server fallback
  if (cfg.geminiApiKey) {
    const keys = parseApiKeys(cfg.geminiApiKey);
    req.geminiApiKeys = keys;
    req.geminiApiKey = keys[0];
    return next();
  }

  return res.status(401).json({
    error:
      'No Gemini API key found on the request. Send it as "Authorization: Bearer <key>" ' +
      '(normally just whatever you put in your client\'s API key field), or set GEMINI_API_KEY ' +
      '(and optionally PROXY_API_KEY) on the server.',
  });
}
