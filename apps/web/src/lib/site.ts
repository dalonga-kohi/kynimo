/** Site-wide facts. Everything a crawler, an LLM or a section needs to agree on lives here. */

const DEFAULT_SITE_URL = "https://web-casio3.vercel.app";

function trimSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

/** Canonical origin. Set NEXT_PUBLIC_SITE_URL when the real domain exists. */
export const SITE_URL = trimSlash(process.env.NEXT_PUBLIC_SITE_URL || DEFAULT_SITE_URL);

/**
 * The hosted MCP endpoint. Unset until the server is deployed: the page then shows a
 * reserved `.example` host and no copy button, so nobody pastes a URL we don't control.
 */
export const MCP_URL = process.env.NEXT_PUBLIC_MCP_URL
  ? trimSlash(process.env.NEXT_PUBLIC_MCP_URL)
  : null;
export const MCP_URL_PLACEHOLDER = "https://mcp.kynimo.example/mcp";

export const REPO_URL = "https://github.com/dalonga-kohi/kynimo";

export const SITE = {
  name: "Kynimo",
  tagline: "Motion graphics that agents create and humans finish.",
  description:
    "Kynimo is a motion graphics engine for AI assistants. Connect it over MCP, describe a video, and get back editable layers and keyframes, checked against motion guidelines.",
} as const;

/** Tools the MCP server registers today (apps/mcp). Keep in step with the server. */
export const MCP_TOOLS = [
  "create_project",
  "get_project",
  "list_projects",
  "get_scene",
  "find_layers",
  "get_layer",
  "get_layer_schema",
  "add_layer",
  "update_layer",
  "set_keyframes",
  "apply_ops",
  "add_mask",
  "set_matte",
  "precompose",
  "undo",
  "redo",
  "upload_asset",
  "list_assets",
  "render_frames",
  "render_contact_sheet",
  "describe_motion",
  "get_capabilities",
  "get_write_outcome",
] as const;

export const FAQ = [
  {
    q: "What is Kynimo?",
    a: "A cloud-hosted motion graphics engine built for AI assistants. Your assistant connects over MCP and builds a video out of layers, keyframes and components. You get a project you can keep editing, not a flat render.",
  },
  {
    q: "Which assistants does it work with?",
    a: "Any client that speaks the Model Context Protocol over HTTP. Kynimo is one remote server with OAuth sign-in, so there is nothing to install.",
  },
  {
    q: "How is this different from AI video generators?",
    a: "Generators return pixels. To change a word you generate again and hope. Kynimo returns a scene document, so a word, a colour or a timing is one small edit and every other frame stays the same.",
  },
  {
    q: "What are quality guidelines?",
    a: "A guideline pack is a motion design system written as tokens and rules: type, colour, springs, durations, safe areas, reading time. Kynimo is being built to grade every render against the pack and tell the assistant exactly what to fix.",
  },
  {
    q: "Can I use it today?",
    a: "Not yet. The scene format, engine, renderer and MCP server are built and tested. The hosted endpoint, quality report and video export come next. The repository is public, so you can follow each step.",
  },
  {
    q: "What will it make?",
    a: "Short motion pieces, 5 to 60 seconds: product launch videos, UI promos, social clips and explainers.",
  },
] as const;

/** What exists in the repository today versus what is planned (docs/ROADMAP.md, 2026-11-10). */
export const STATUS = {
  built: [
    ["Scene format", "A versioned JSON document. Every change is a typed operation."],
    ["Engine", "Bezier and spring keyframes, parenting, precomps. Integer frames."],
    ["Renderer", "Shapes, text, images, video. Masks, mattes and blend modes."],
    ["Shape operators", "Trim paths, repeater, round corners, path morphing."],
    ["Text animators", "Per character, word and line, with range selectors."],
    ["MCP server", "Streamable HTTP with OAuth. Frames come back as images."],
    ["Guideline packs", "Four drafts: Keynote, Playful SaaS, Editorial, Brutalist."],
  ],
  next: [
    ["Hosted endpoint", "One URL for every client."],
    ["Intent tools", "Animate, stagger, retime. Your assistant says what, not how."],
    ["Scripts", "Your assistant writes TypeScript. The scene gets ordinary layers."],
    ["Quality report", "Every finding names the frame and the fix."],
    ["Components and shaders", "TypeScript and GLSL, with typed props."],
    ["Export", "MP4, WebM, GIF and a link your team can scrub."],
  ],
} as const;
