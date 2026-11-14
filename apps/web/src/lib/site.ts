/** Site-wide facts. Everything a crawler, an LLM or a section needs to agree on lives here. */

const DEFAULT_SITE_URL = "https://www.kynimo.site";

function trimSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

/** Canonical origin. Override with NEXT_PUBLIC_SITE_URL. */
export const SITE_URL = trimSlash(process.env.NEXT_PUBLIC_SITE_URL || DEFAULT_SITE_URL);

export const REPO_URL = "https://github.com/dalonga-kohi/kynimo";
export const ISSUES_URL = `${REPO_URL}/issues`;

/** Where the Windows installer comes from. Override with NEXT_PUBLIC_DOWNLOAD_URL. */
export const DOWNLOAD_URL = trimSlash(
  process.env.NEXT_PUBLIC_DOWNLOAD_URL || `${REPO_URL}/releases/latest`,
);

export const BETA_PATH = "/beta";

export const SITE = {
  name: "Kynimo",
  tagline: "Motion graphics for your AI agent.",
  description:
    "Kynimo is a desktop motion graphics engine for AI agents. Connect Claude, Cursor or any MCP client, describe a video, and get editable layers and keyframes.",
} as const;

/** Tools the MCP server registers today (apps/mcp/src/server.ts). Keep in step with the server. */
export const MCP_TOOLS = [
  "create_project",
  "list_projects",
  "get_project",
  "upload_asset",
  "list_assets",
  "get_scene",
  "find_layers",
  "get_layer",
  "describe_motion",
  "get_layer_schema",
  "get_capabilities",
  "get_write_outcome",
  "render_frames",
  "render_contact_sheet",
  "export",
  "render_preview_clip",
  "get_export_status",
  "cancel_export",
  "get_preview_link",
  "apply_ops",
  "add_layer",
  "update_layer",
  "set_keyframes",
  "add_mask",
  "set_matte",
  "precompose",
  "animate",
  "apply_preset",
  "stagger",
  "retime",
  "mark_beats",
  "sync_to_beats",
  "add_component",
  "build_from_brief",
  "add_effect",
  "add_transition",
  "import_svg",
  "add_behavior",
  "run_script",
  "get_script",
  "define_shader",
  "define_component",
  "list_definitions",
  "list_components",
  "list_presets",
  "undo",
  "redo",
] as const;

/** What the agent does with Kynimo, in order. */
export const LOOP = [
  {
    step: "Brief",
    body: "Say what the video is for, in plain words. A launch teaser, a feature promo, a ten second social clip.",
    tools: [],
  },
  {
    step: "Build",
    body: "Your agent lays out shapes, text, images and your footage, then animates them with spring and bezier keyframes.",
    tools: ["add_layer", "set_keyframes", "animate", "run_script"],
  },
  {
    step: "Look",
    body: "Rendered frames come back into the chat as images. The agent sees what it made, not what it meant.",
    tools: ["render_frames", "render_contact_sheet"],
  },
  {
    step: "Check",
    body: "It reads the motion back as a timeline: what moves, when, and for how long.",
    tools: ["describe_motion"],
  },
  {
    step: "Fix",
    body: "Small typed edits to the scene. One layer changes, and every other frame stays exactly as it was.",
    tools: ["apply_ops", "undo"],
  },
  {
    step: "Export",
    body: "MP4, WebM or GIF, rendered on your machine. The project stays editable.",
    tools: ["export", "get_export_status"],
  },
] as const;

export const FAQ = [
  {
    q: "What is Kynimo?",
    a: "A motion graphics engine built for AI agents. It runs on your computer as a desktop app. Your agent connects over MCP and builds a video out of layers, keyframes and components. You get a project you can keep editing, not a flat render.",
  },
  {
    q: "Can I use it today?",
    a: "Yes, on Windows. Kynimo is in private beta and the installer is on the beta page. It is early, so expect rough edges and tell us what breaks.",
  },
  {
    q: "Which agents does it work with?",
    a: "Any MCP client. The app has copy and paste setup for Claude Code, Codex, Cursor and Claude Desktop, and a stdio option for clients that only start local servers.",
  },
  {
    q: "How is this different from AI video generators?",
    a: "Generators return pixels. To change a word you generate again and hope. Kynimo returns a scene document, so a word, a colour or a timing is one small edit and every other frame stays the same.",
  },
  {
    q: "Does my work leave my machine?",
    a: "Not through Kynimo. The engine, the renderer and the export all run locally, and your projects live in a folder on your disk. There is no account. Your agent's model provider still sees what the agent sends it, as in any chat.",
  },
  {
    q: "What can it make?",
    a: "Short motion pieces, 5 to 60 seconds: product launch videos, UI promos, social clips and explainers.",
  },
  {
    q: "Is it open source?",
    a: "Yes. The code is on GitHub under the Apache 2.0 license.",
  },
  {
    q: "What about macOS and Linux?",
    a: "Windows comes first. macOS and Linux builds are in the works.",
  },
] as const;
