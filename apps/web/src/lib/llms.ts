import { BETA_PATH, FAQ, LOOP, MCP_TOOLS, REPO_URL, SITE, SITE_URL } from "./site";

const STATUS_LINE =
  "Private beta on Windows. The engine, MCP server, frame rendering, video export and desktop app are built. Style packs and the automatic quality report are in progress.";

/** llms.txt: the short index, in the llmstxt.org shape. */
export function llmsTxt(): string {
  return `# ${SITE.name}

> ${SITE.tagline} ${SITE.description}

Status: ${STATUS_LINE}

## Start here

- [Landing page](${SITE_URL}/): what Kynimo is, what an agent does with it, the desktop app and the features
- [Windows beta](${SITE_URL}${BETA_PATH}): download the installer, set up your agent, what is in the beta and what is not
- [Full description for language models](${SITE_URL}/llms-full.txt): the whole site as plain text, with the tool list and FAQ

## Source and docs

- [Repository](${REPO_URL}): source code, public, Apache 2.0
- [Product](${REPO_URL}/blob/main/PRODUCT.md): what it is and who it is for
- [Architecture](${REPO_URL}/blob/main/docs/ARCHITECTURE.md): scene graph, engine, renderer, MCP server
- [Capabilities](${REPO_URL}/blob/main/docs/CAPABILITIES.md): what the engine can express
- [Roadmap](${REPO_URL}/blob/main/docs/ROADMAP.md): what is built and what is next

## Optional

- [Decision records](${REPO_URL}/tree/main/docs/decisions): why each architectural choice was made
`;
}

/** llms-full.txt: everything on the site, as text a model can quote. */
export function llmsFullTxt(): string {
  return `# ${SITE.name}

> ${SITE.tagline}

${SITE.description}

Website: ${SITE_URL}/
Windows beta: ${SITE_URL}${BETA_PATH}
Repository: ${REPO_URL}
Status: ${STATUS_LINE}

## What it is

Kynimo is a motion graphics engine built for AI agents. It runs on your computer as a desktop app for Windows. An AI agent connects over the Model Context Protocol (MCP), builds a motion video from layers, keyframes and components, and looks at the frames it rendered. The result is a scene document a person can keep editing, not a flat video file.

It is for developers, founders and marketers who need short motion pieces (5 to 60 seconds): product launch videos, UI promos, social clips and explainers.

## Why it is different

- AI video generators return pixels. Changing one word means generating again. Kynimo returns an editable scene: a word, a colour or a timing is one small operation, and every other frame stays the same.
- Rendering is deterministic. The same document and the same frame always give the same pixels.
- It runs locally. The engine, the renderer and the export run on your machine, projects live in a folder on your disk, and there is no account.

## How an agent connects

The desktop app starts a local MCP server. The Connect screen shows the local address and copy and paste setup for Claude Code, Codex, Cursor and Claude Desktop. Clients that only start local servers can use a stdio option.

1. Install the Windows beta from ${SITE_URL}${BETA_PATH}.
2. Open the Connect screen and paste the setup into your MCP client.
3. Ask for a video. The animation appears in the app, ready to play back and export.

## What an agent does with it

${LOOP.map((item, i) => `${i + 1}. **${item.step}**: ${item.body}${item.tools.length > 0 ? ` Tools: ${item.tools.map((t) => `\`${t}\``).join(", ")}.` : ""}`).join("\n")}

## Tools on the MCP server today

${MCP_TOOLS.map((tool) => `- \`${tool}\``).join("\n")}

## In the beta

- The full engine: layers, bezier and spring keyframes, text animators, shape operators, masks, effects, cameras and shaders.
- A local MCP server that starts with the app, over HTTP or stdio.
- Playback of every animation in your projects, with a player and a timeline.
- Export to MP4, WebM and GIF, rendered on your machine.

## Not there yet

- Editing in the app. For now the agent makes the changes.
- Style packs and the automatic quality report.
- Signed installers and automatic updates.
- macOS and Linux builds.

## Questions

${FAQ.map(({ q, a }) => `### ${q}\n\n${a}`).join("\n\n")}
`;
}
