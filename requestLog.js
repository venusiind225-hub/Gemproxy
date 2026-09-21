// One readable line per completed request, to stdout — Railway captures
// stdout as your deploy's logs automatically, nothing extra to configure.
// Kept separate from morgan (which logs the raw HTTP method/path/status
// line) since morgan has no idea what model was requested or how many
// tokens Gemini counted — that only becomes known once we've parsed
// Gemini's own response.
//
// Deliberately plain `key=value` text rather than JSON: Railway's log
// viewer free-text-searches stdout, so `model=gemini-2.5-flash` or
// `status=429` are both directly searchable as-is. Switch this to
// `console.log(JSON.stringify({...}))` instead if you'd rather pipe these
// into something structured later — every field below would carry over
// unchanged.
export function logGeminiRequest({
  model,
  stream,
  status,
  finishReason,
  promptTokens,
  completionTokens,
  totalTokens,
  durationMs,
  error,
  key,
}) {
  const parts = [`model=${model}`];
  if (key !== undefined) parts.push(`key=${key}`);
  parts.push(`stream=${stream}`, `status=${status}`);

  if (finishReason !== undefined) parts.push(`finishReason=${finishReason}`);
  if (promptTokens !== undefined) parts.push(`promptTokens=${promptTokens}`);
  if (completionTokens !== undefined) parts.push(`completionTokens=${completionTokens}`);
  if (totalTokens !== undefined) parts.push(`totalTokens=${totalTokens}`);

  parts.push(`duration=${durationMs}ms`);

  if (error) {
    parts.push(`error="${String(error).replace(/"/g, "'")}"`);
  }

  const line = `[gemini] ${parts.join(' ')}`;
  if (error) console.error(line);
  else console.log(line);
}
