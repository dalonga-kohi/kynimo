import { describe, expect, it } from "vitest";
import { llmsFullTxt, llmsTxt } from "./llms";
import { BETA_PATH, MCP_TOOLS, SITE_URL } from "./site";

describe("llms documents", () => {
  for (const [name, text] of [
    ["llms.txt", llmsTxt()],
    ["llms-full.txt", llmsFullTxt()],
  ] as const) {
    it(`${name} points at the beta page and has no stale claims`, () => {
      expect(text).toContain(`${SITE_URL}${BETA_PATH}`);
      expect(text).not.toMatch(/assistant|cloud-hosted|OAuth/i);
    });
  }

  it("llms-full.txt lists every MCP tool", () => {
    const text = llmsFullTxt();
    for (const tool of MCP_TOOLS) expect(text).toContain(`\`${tool}\``);
  });
});
