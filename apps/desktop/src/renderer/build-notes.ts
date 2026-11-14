/** What the dialog "What's in this build" says. */
export const BUILD_NOTES = {
  highlights: [
    "Runs locally on Windows: the server starts with the app, and nothing leaves your machine.",
    "Connect any MCP client over HTTP, or over stdio for clients that launch their own servers.",
    "Agents build, check and export animations: layers, keyframes, style packs and frame checks.",
    "The library shows every animation, and the player plays it with a layer timeline.",
    "Export to MP4, WebM or GIF, saved wherever you choose.",
  ],
  roughEdges: [
    "The first render can take a few seconds to warm up; it downloads nothing.",
    "This build is unsigned, so Windows SmartScreen may ask you to confirm before it runs.",
  ],
} as const;
