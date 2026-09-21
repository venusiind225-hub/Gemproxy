import { config } from '../config.js';

// Applies config-level generation defaults (temperature / top_p /
// max_tokens) to an OpenAI-SHAPED request body (flat top-level fields),
// but only for fields the client didn't already set explicitly. Also
// enforces the hard maxTokensCap regardless of whether the value came from
// the client or from defaultMaxTokens. presence_penalty is intentionally
// never touched here — it's dropped further downstream, see
// routes/openaiCompat.js's toGenerationConfig.
//
// Used by routes/openaiCompat.js (OpenAI-compat translator).
export function applyGenerationDefaults(body) {
  if (!body || typeof body !== 'object') return body;
  const result = { ...body };

  if (result.temperature === undefined && config.defaultTemperature !== undefined) {
    result.temperature = config.defaultTemperature;
  }
  if (result.top_p === undefined && config.defaultTopP !== undefined) {
    result.top_p = config.defaultTopP;
  }
  if (result.max_tokens === undefined && config.defaultMaxTokens !== undefined) {
    result.max_tokens = config.defaultMaxTokens;
  }
  if (config.maxTokensCap !== undefined && typeof result.max_tokens === 'number') {
    result.max_tokens = Math.min(result.max_tokens, config.maxTokensCap);
  }
  return result;
}

// --- Thinking config -------------------------------------------------------
//
// Gemini 2.5 models control reasoning depth with a numeric thinkingBudget
// (token count; 0 = off, -1 = dynamic). Gemini 3.x models (gemini-3-flash,
// gemini-3.1-flash-lite, gemini-3.5-flash, gemini-3.6-flash, gemini-3.7-flash,
// gemini-3.8-flash, ...) replaced that with a discrete thinkingLevel instead:
// 'minimal' | 'low' | 'medium' | 'high'. thinkingBudget is still accepted on
// 3.x for backward compatibility, but Google recommends thinkingLevel there.
//
// Quirk worth knowing: gemini-3.7-flash and gemini-3.8-flash both reject
// thinkingLevel: 'minimal' with a 400 error — 'low' is the lightest setting
// that works on those two. gemini-3.6-flash and earlier 3.x models accept
// 'minimal'.
const GEMINI_3_MODEL = /^gemini-3(\.\d+)?(-|$)/;

export function isGemini3Model(model) {
  return typeof model === 'string' && GEMINI_3_MODEL.test(model);
}

const THINKING_LEVELS = new Set(['minimal', 'low', 'medium', 'high']);

// Approximate thinkingBudget (token count) equivalent for each effort level,
// used only on Gemini 2.5 models — which predate thinkingLevel and only
// understand a numeric budget. Gemini 3.x models get the REASONING_EFFORT
// value sent directly as thinkingLevel instead, no mapping needed.
const EFFORT_TO_BUDGET = {
  minimal: 0,
  low: 2048,
  medium: 8192,
  high: 24576,
};

// Resolves the thinkingConfig object to send to Gemini for this request, or
// undefined if thinking wasn't requested/configured at all (in which case
// the model's own default behavior applies untouched).
//
// Precedence: an explicit per-request field on the body always wins over
// config, regardless of ENABLE_THINKING — that switch only controls whether
// OUR default kicks in when the client didn't ask for anything themselves.
//   - body.reasoning_effort / body.thinking_level: 'minimal'|'low'|'medium'|'high'
//     (OpenAI-style shorthand — matches OpenAI's own reasoning_effort
//     naming, in case a client ever sends it)
//   - body.thinking_budget: integer, used as-is regardless of model family
//   - body.include_thoughts: boolean
export function resolveThinkingConfig(model, body, cfg = config) {
  const requestedLevel = body?.reasoning_effort ?? body?.thinking_level;
  const requestedBudget = body?.thinking_budget;
  const requestedIncludeThoughts = body?.include_thoughts;

  const level = THINKING_LEVELS.has(requestedLevel)
    ? requestedLevel
    : cfg.enableThinking
    ? cfg.reasoningEffort
    : undefined;

  const includeThoughts =
    requestedIncludeThoughts !== undefined ? Boolean(requestedIncludeThoughts) : cfg.showReasoning;

  const thinkingConfig = {};

  if (requestedBudget !== undefined) {
    thinkingConfig.thinkingBudget = requestedBudget;
  } else if (level) {
    if (isGemini3Model(model)) {
      thinkingConfig.thinkingLevel = level;
    } else {
      thinkingConfig.thinkingBudget = EFFORT_TO_BUDGET[level] ?? -1;
    }
  }

  if (includeThoughts) {
    thinkingConfig.includeThoughts = true;
  }

  return Object.keys(thinkingConfig).length ? thinkingConfig : undefined;
}

// Splits a Gemini candidate's parts into the visible answer and any thought
// summaries (parts with thought: true, only present when includeThoughts is
// on). Keeps chain-of-thought out of the actual chat message so callers can
// decide how to present it (see routes/openaiCompat.js, which wraps it in
// <think></think> tags).
export function extractParts(candidate) {
  const parts = candidate?.content?.parts || [];
  let content = '';
  let reasoning = '';
  for (const part of parts) {
    if (!part.text) continue;
    if (part.thought) reasoning += part.text;
    else content += part.text;
  }
  return { content, reasoning };
    }
