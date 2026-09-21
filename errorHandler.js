export function errorHandler(err, req, res, next) {
  // Log full detail server-side only; never echo internals back to the client.
  console.error('[proxy error]', err.message);

  if (res.headersSent) {
    return next(err);
  }

  res.status(err.status || 502).json({
    error: 'Upstream or proxy error. Check the server logs for details.',
  });
}

export default errorHandler;
