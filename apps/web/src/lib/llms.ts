import { FAQ, MCP_TOOLS, MCP_URL, REPO_URL, SITE, SITE_URL, STATUS } from "./site";

const list = (items: readonly (readonly [string, string])[]) =>
  items.map(([name, body]) => `- **${name}**: ${body}`).join("\n");

const endpoint = MCP_URL
  ? `MCP endpoint: ${MCP_URL} (Streamable HTTP, OAuth).`
  : "The hosted MCP endpoint is not public yet. It opens with the private beta.";

/** llms.txt: the short index, in the llmstxt.org shape. */
export function llmsTxt(): string {
  return `# ${SITE.name}

> ${SITE.tagline} ${SITE.description}

Status: in development. The scene format, engine, renderer and MCP server are built. The hosted endpoint, quality report and video export are not available yet. ${endpoint}

## Start here

- [Landing page](${SITE_URL}/): what Kynimo is, how an assistant connects, how quality guidelines work
- [Full description for language models](${SITE_URL}/llms-full.txt): the whole page as plain text, with the tool list and FAQ

## Source and docs

- [Repository](${REPO_URL}): source code, public
- [Product](${REPO_URL}/blob/main/PRODUCT.md): what it is and who it is for
- [Architecture](${REPO_URL}/blob/main/docs/ARCHITECTURE.md): scene graph, engine, renderer, MCP server
- [Capabilities](${REPO_URL}/blob/main/docs/CAPABILITIES.md): what the engine can express
- [Roadmap](${REPO_URL}/blob/main/docs/ROADMAP.md): what is built and what is next

## Optional

- [Decision records](${REPO_URL}/tree/main/docs/decisions): why each architectural choice was made
`;
}

/** llms-full.txt: everything on the page, as text a model can quote. */
export function llmsFullTxt(): string {
  return `# ${SITE.name}

> ${SITE.tagline}

${SITE.description}

Website: ${SITE_URL}/
Repository: ${REPO_URL}
Status: in development, not yet usable by the public. ${endpoint}

## What it is

Kynimo is an agent-first, cloud-hosted motion graphics engine. An AI assistant connects over the Model Context Protocol (MCP), builds a motion video from layers, keyframes and components, and looks at rendered frames. A quality report that tells it what to fix is planned. The result is a scene document a person can keep editing, not a flat video file.

It is for developers, founders and marketers who need short motion pieces (5 to 60 seconds): product launch videos, UI promos, social clips and explainers.

## Why it is different

- AI video generators return pixels. Changing one word means generating again. Kynimo returns an editable scene: a word, a colour or a timing is one small operation, and every other frame stays the same.
- Rendering is deterministic. The same document and the same frame always give the same pixels.
- Quality is meant to be enforced by rules, not left to the model. Guideline packs encode type, colour, springs, durations, safe areas and reading time.
- It is designed to be hosted: the assistant connects with one URL and OAuth, with nothing to install. The hosted endpoint is not public yet.

## How an assistant connects

Kynimo is a remote MCP server (Streamable HTTP, OAuth sign-in). ${endpoint}

1. Add the server to an MCP client such as Claude Code or Cursor.
2. Sign in with OAuth in the browser. There are no API keys to paste.
3. Ask for a video. Preview frames come back into the same chat.

## Tools on the MCP server today

${MCP_TOOLS.map((tool) => `- \`${tool}\``).join("\n")}

## Quality guidelines

A guideline pack is a motion design system written as tokens and rules. Four draft packs (version 0.1.0) exist: Keynote, Playful SaaS, Editorial and Brutalist. Rules include \`readable-hold\`, \`safe-area\`, \`text-contrast\`, \`token-easing\`, \`concurrent-motion\`, \`min-text-size\` and \`flash-rate\`. The engine that grades a render against a pack and reports findings with suggested fixes is planned, not built.

## What runs today

${list(STATUS.built)}

## What comes next

${list(STATUS.next)}

## Questions

${FAQ.map(({ q, a }) => `### ${q}\n\n${a}`).join("\n\n")}
`;
}
