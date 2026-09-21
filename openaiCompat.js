import express from 'express';
import { config } from '../config.js';
import { applyGenerationDefaults, resolveThinkingConfig, extractParts } from '../lib/generationDefaults.js';
import { applyRoleplayTricks, friendlyErrorMessage } from '../lib/roleplayTricks.js';
import { fetchWithRetry } from '../lib/upstreamFetch.js';
import { logGeminiRequest } from '../lib/requestLog.js';
import {
  getCandidateKeys,
  markKeyExhausted,
  markKeySuccess,
  maskKey,
  isKeyExhaustionError,
} from '../lib/keyManager.js';

const router = express.Router();

// Maps each Gemini harm category to the key used to look up its threshold
// in config.safetyThresholds. If a category has no entry there, it falls
// back to config.safetyThreshold (kept for backward compatibility), and
// finally to Gemini's own default if neither is set.
const SAFETY_CATEGORIES = [
  { category: 'HARM_CATEGORY_HARASSMENT', key: 'harassment' },
  { category: 'HARM_CATEGORY_HATE_SPEECH', key: 'hateSpeech' },
  { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', key: 'sexuallyExplicit' },
  { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', key: 'dangerousContent' },
  { category: 'HARM_CATEGORY_JAILBREAK', key: 'jailbreak' },
];

function buildSafetySettings() {
  return SAFETY_CATEGORIES.map(({ category, key }) => {
    const threshold =
      config.safetyThresholds?.[key] ??
      config.safetyThreshold ??
      'BLOCK_NONE';
    return { category, threshold };
  });
}

// OpenAI-shaped `content` is usually a plain string, but some clients
// (and the OpenAI spec itself, for vision-capable calls) send an array of
// parts instead: [{ type: 'text', text: '...' }, ...]. Handling only the
// string case silently turned an array into the literal text
// "[object Object]" — flattening it properly here means the proxy won't
// mangle a message just because a future client (or a Janitor update)
// switches shapes.
function flattenContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part.text === 'string') return part.text;
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  if (content == null) return '';
  return String(content);
}

// How the client's message array becomes Gemini's `contents`:
//
// - Every LEADING `system` message (character card + persona + custom
//   system prompt — Janitor concatenates all of these into one system
//   message before it ever reaches this proxy, so there's nothing more
//   structured to pull apart) is folded into a single `model` turn at the
//   very start, instead of going through Gemini's dedicated
//   systemInstruction channel. Gemini treats a `model` turn as its own
//   prior output to continue from rather than an external instruction to
//   evaluate, which keeps it in-character far more reliably for roleplay —
//   systemInstruction is more prone to breaking character or adding
//   disclaimers.
// - A `system` message that shows up LATER, interleaved with real turns —
//   a depth-injected "author's note" / reminder, the kind SillyTavern-style
//   clients insert a few turns back from the end rather than at the very
//   top — is left where it is and turned into a bracketed note on a `user`
//   turn instead of being hoisted into the header. That's what makes those
//   reminders effective in the first place (recency); flattening everything
//   to position 0 would throw that away.
// - Consecutive turns of the same effective role get merged. Gemini expects
//   (and behaves best with) strict user/model alternation, and both the
//   synthetic header turn and a mid-conversation system note above can
//   otherwise land two `model` or two `user` turns back to back.
// - If the conversation doesn't end on a `user` turn (e.g. a trailing
//   prefill/swipe leaves the last message as `assistant`), a harmless
//   filler `user` turn is appended — Gemini's API 400s otherwise.
function toGeminiContents(messages = []) {
  let i = 0;
  const headerParts = [];
  while (i < messages.length && messages[i].role === 'system') {
    const text = flattenContent(messages[i].content);
    if (text) headerParts.push(text);
    i++;
  }

  const turns = [];
  for (; i < messages.length; i++) {
    const msg = messages[i];
    const text = flattenContent(msg.content);

    if (msg.role === 'system') {
      turns.push({ role: 'user', parts: [{ text: `[System note: ${text}]` }] });
      continue;
    }

    const role = msg.role === 'assistant' ? 'model' : 'user';
    const prefix = msg.name ? `${msg.name}: ` : '';
    turns.push({ role, parts: [{ text: prefix + text }] });
  }

  if (headerParts.length) {
    turns.unshift({ role: 'model', parts: [{ text: headerParts.join('\n\n') }] });
  }

  const contents = [];
  for (const turn of turns) {
    const prev = contents[contents.length - 1];
    if (prev && prev.role === turn.role) {
      prev.parts[0].text += `\n\n${turn.parts[0].text}`;
    } else {
      contents.push(turn);
    }
  }

  if (contents.length && contents[contents.length - 1].role !== 'user') {
    contents.push({ role: 'user', parts: [{ text: '.' }] });
  }

  return { contents };
}

function toGenerationConfig(body) {
  const cfg = {};
  if (body.temperature !== undefined) cfg.temperature = body.temperature;
  if (body.top_p !== undefined) cfg.topP = body.top_p;
  if (body.top_k !== undefined) cfg.topK = body.top_k;
  if (body.max_tokens !== undefined) cfg.maxOutputTokens = body.max_tokens;
  if (body.stop !== undefined) {
    cfg.stopSequences = Array.isArray(body.stop) ? body.stop : [body.stop];
  }
  // presence_penalty and seed are intentionally dropped — never forwarded
  // to Gemini, regardless of what the client sends. A pinned seed makes
  // Gemini reproduce (near-)identical output for the same context on every
  // call, which flattens variety on regenerates/swipes instead of helping.
  if (body.frequency_penalty !== undefined) cfg.frequencyPenalty = body.frequency_penalty;
  if (body.n !== undefined) cfg.candidateCount = body.n;
  return cfg;
}

function finishReasonToOpenAI(reason) {
  switch (reason) {
    case 'MAX_TOKENS':
      return 'length';
    case 'SAFETY':
    case 'RECITATION':
      return 'content_filter';
    default:
      return 'stop';
  }
}

// Translates your app's normal OpenAI-style chat request into Gemini's
// native generateContent format (which actually respects safetySettings,
// unlike Google's own OpenAI-compat wrapper), then translates the native
// response back into OpenAI's shape so your app sees no difference.
//
// Also resolves Gemini's thinking config (see resolveThinkingConfig) and,
// when thought summaries come back, wraps them in <think></think> tags and
// prepends them to the visible message content (see extractParts).
//
// Limitations: single candidate only (n>1 not translated), no function/tool
// call translation. Fine for plain chat/roleplay; let me know if you need
// either of those and I'll extend it.
router.post('/v1beta/openai/chat/completions', async (req, res, next) => {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), config.requestTimeoutMs);
  const startedAt = Date.now();
  let model = 'unknown';
  let wantsStream = false;
  let activeKey = req.geminiApiKey;

  try {
    const body = applyGenerationDefaults(req.body || {});
    model = body.model || 'gemini-flash-latest';
    const messages = applyRoleplayTricks(body.messages || [], config);
    const { contents } = toGeminiContents(messages);

    const generationConfig = toGenerationConfig(body);
    const thinkingConfig = resolveThinkingConfig(model, body, config);
    if (thinkingConfig) generationConfig.thinkingConfig = thinkingConfig;

    const geminiBody = {
      contents,
      generationConfig,
      safetySettings: buildSafetySettings(),
      ...(config.enableGoogleSearch ? { tools: [{ googleSearch: {} }] } : {}),
    };

    wantsStream = Boolean(body.stream);
    const method = wantsStream ? 'streamGenerateContent' : 'generateContent';
    const targetUrl = new URL(
      `/v1beta/models/${model}:${method}${wantsStream ? '?alt=sse' : ''}`,
      config.geminiBaseUrl
    );

    const allKeys = req.geminiApiKeys?.length ? req.geminiApiKeys : (req.geminiApiKey ? [req.geminiApiKey] : []);
    const candidateKeys = getCandidateKeys(allKeys);

    let upstream;
    let lastErrorText = '';
    let lastParsedError;

    // Cycle through keys if an active key runs out
    for (let i = 0; i < candidateKeys.length; i++) {
      activeKey = candidateKeys[i];

      const headers = new Headers({ 'content-type': 'application/json' });
      headers.set('x-goog-api-key', activeKey);

      upstream = await fetchWithRetry(
        targetUrl,
        {
          method: 'POST',
          headers,
          body: JSON.stringify(geminiBody),
          signal: controller.signal,
        },
        { attempts: config.retryAttempts, baseDelayMs: config.retryBaseDelayMs }
      );

      if (upstream.ok) {
        markKeySuccess(activeKey, allKeys);
        break;
      }

      const errText = await upstream.text();
      lastErrorText = errText;
      try {
        lastParsedError = JSON.parse(errText)?.error;
      } catch {
        lastParsedError = undefined;
      }

      const isExhausted = isKeyExhaustionError(upstream.status, lastParsedError, errText);
      const hasNextKey = i < candidateKeys.length - 1;

      if (isExhausted) {
        markKeyExhausted(
          activeKey,
          config.keyCooldownMs,
          lastParsedError?.message || 'Quota exhausted',
          allKeys
        );
        if (hasNextKey) {
          const nextKey = candidateKeys[i + 1];
          console.warn(
            `[gemini] Key ${maskKey(activeKey)} ran out (status ${upstream.status}). ` +
            `Cycling to next key ${maskKey(nextKey)} (${i + 2}/${candidateKeys.length})...`
          );
          continue;
        } else {
          console.warn(
            `[gemini] Key ${maskKey(activeKey)} ran out (status ${upstream.status}). ` +
            `All ${candidateKeys.length} keys exhausted.`
          );
        }
      }

      // Non-exhaustion error (e.g. 400 bad request/invalid model) won't be fixed by changing keys
      break;
    }
    clearTimeout(timeoutId);

    if (!upstream.ok) {
      let message = lastParsedError?.message || lastErrorText;
      message = friendlyErrorMessage(lastParsedError, message, model);
      logGeminiRequest({
        model,
        stream: wantsStream,
        status: upstream.status,
        durationMs: Date.now() - startedAt,
        error: message,
        key: maskKey(activeKey),
      });
      return res.status(upstream.status).json({ error: { message } });
    }

    const completionId = `chatcmpl-${Date.now()}`;
    const createdTs = Math.floor(Date.now() / 1000);

    if (!wantsStream) {
      const data = await upstream.json();
      const candidate = data.candidates?.[0];
      const { content, reasoning } = extractParts(candidate);
      const finalContent = reasoning ? `<think>${reasoning}</think>\n\n${content}` : content;
      const usage = {
        prompt_tokens: data.usageMetadata?.promptTokenCount || 0,
        completion_tokens: data.usageMetadata?.candidatesTokenCount || 0,
        total_tokens: data.usageMetadata?.totalTokenCount || 0,
      };
      logGeminiRequest({
        model,
        stream: false,
        status: 200,
        finishReason: candidate?.finishReason,
        promptTokens: usage.prompt_tokens,
        completionTokens: usage.completion_tokens,
        totalTokens: usage.total_tokens,
        durationMs: Date.now() - startedAt,
        key: maskKey(activeKey),
      });
      return res.json({
        id: completionId,
        object: 'chat.completion',
        created: createdTs,
        model,
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: finalContent,
            },
            finish_reason: finishReasonToOpenAI(candidate?.finishReason),
          },
        ],
        usage,
      });
    }

    // Streaming response
    res.setHeader('content-type', 'text/event-stream');
    res.setHeader('cache-control', 'no-cache');
    res.setHeader('connection', 'keep-alive');

    let buffer = '';
    let thinkOpen = false;
    let thinkClosed = false;
    let usage;
    let lastFinishReason;

    function buildDelta(content, reasoning) {
      let text = '';
      if (reasoning) {
        if (!thinkOpen) {
          text += '<think>';
          thinkOpen = true;
        }
        text += reasoning;
      }
      if (content) {
        if (thinkOpen && !thinkClosed) {
          text += '</think>';
          thinkClosed = true;
        }
        text += content;
      }
      return text;
    }

    function processSseLine(line) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) return;
      const payload = trimmed.slice(5).trim();
      if (!payload || payload === '[DONE]') return;

      try {
        const parsed = JSON.parse(payload);
        const candidate = parsed.candidates?.[0];
        const { content, reasoning } = extractParts(candidate);
        const finishReason = candidate?.finishReason
          ? finishReasonToOpenAI(candidate.finishReason)
          : null;
        if (candidate?.finishReason) lastFinishReason = candidate.finishReason;
        if (parsed.usageMetadata) usage = parsed.usageMetadata;

        let deltaText = buildDelta(content, reasoning);
        if (finishReason && thinkOpen && !thinkClosed) {
          deltaText += '</think>';
          thinkClosed = true;
        }

        res.write(
          `data: ${JSON.stringify({
            id: completionId,
            object: 'chat.completion.chunk',
            created: createdTs,
            model,
            choices: [
              {
                index: 0,
                delta: deltaText ? { content: deltaText } : {},
                finish_reason: finishReason,
              },
            ],
          })}\n\n`
        );
      } catch {
        // Skip malformed chunk
      }
    }

    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();

    req.on('close', () => reader.cancel().catch(() => {}));

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        processSseLine(line);
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) {
      processSseLine(buffer);
    }

    res.write('data: [DONE]\n\n');
    res.end();
    logGeminiRequest({
      model,
      stream: true,
      status: 200,
      finishReason: lastFinishReason ?? 'STREAM_CLOSED_WITHOUT_FINISH_REASON',
      promptTokens: usage?.promptTokenCount,
      completionTokens: usage?.candidatesTokenCount,
      totalTokens: usage?.totalTokenCount,
      durationMs: Date.now() - startedAt,
      key: maskKey(activeKey),
    });
  } catch (err) {
    clearTimeout(timeoutId);
    if (err.name === 'AbortError') {
      logGeminiRequest({
        model,
        stream: wantsStream,
        status: 504,
        durationMs: Date.now() - startedAt,
        error: 'Upstream Gemini request timed out.',
        key: maskKey(activeKey),
      });
      return res.status(504).json({ error: { message: 'Upstream Gemini request timed out.' } });
    }
    next(err);
  }
});

export default router;
  
