/** The renderer's Content-Security-Policy in the built app. */
export const CSP =
  "default-src 'self'; img-src 'self' kynimo-media: data:; media-src kynimo-media:; style-src 'self' 'unsafe-inline'; font-src 'self'";

/** Development only: the dev server's inline React preamble and its websocket. */
export const DEV_CSP = `${CSP}; script-src 'self' 'unsafe-inline'; connect-src 'self' ws:`;
