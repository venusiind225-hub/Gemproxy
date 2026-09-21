import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';

import { config } from './config.js';
import { resolveApiKey } from './middleware/auth.js';
import { rateLimiter } from './middleware/rateLimiter.js';
import { errorHandler } from './middleware/errorHandler.js';
import openaiCompatRouter from './routes/openaiCompat.js';

const app = express();

// Railway sits behind an edge proxy — trust it so req.ip and the rate
// limiter see the real client IP instead of Railway's internal one.
app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use(helmet());
app.use(morgan(config.nodeEnv === 'production' ? 'combined' : 'dev'));
app.use(express.json({ limit: '100mb' }));

// Allows any origin to call this proxy directly from the browser.
// Access is still gated by resolveApiKey below — CORS only controls
// which sites' JS can read the response, not who can reach the server.
app.use(cors());

// Public health check for Railway's own monitoring — no secret required.
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'gemini-railway-proxy' });
});

// Everything under /v1beta and /v1 is rate-limited and needs a resolvable
// Gemini API key (see middleware/auth.js for the three ways that can be
// satisfied) before being handed to the proxy route.
app.use('/v1beta', rateLimiter, resolveApiKey);
app.use('/v1', rateLimiter, resolveApiKey);
app.use('/', openaiCompatRouter);

app.use((req, res) => {
  res.status(404).json({ error: 'Not found.' });
});

app.use(errorHandler);

app.listen(config.port, () => {
  console.log(`Gemini proxy listening on port ${config.port} (${config.nodeEnv})`);
});
