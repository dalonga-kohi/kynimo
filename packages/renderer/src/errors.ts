/** A frame cannot be rendered as the document asks; the message says what to change. */
export class RenderError extends Error {
  override name = "RenderError";
}
