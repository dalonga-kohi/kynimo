import { describe, expect, it } from "vitest";
import { DOWNLOAD_URL, FAQ, LOOP, MCP_TOOLS, REPO_URL, SITE } from "./site";

const strings = [
  ...Object.values(SITE),
  ...LOOP.flatMap((item) => [item.step, item.body, ...item.tools]),
  ...FAQ.flatMap(({ q, a }) => [q, a]),
];

describe("site facts", () => {
  it("keeps the description short enough for search results", () => {
    expect(SITE.description.length).toBeLessThanOrEqual(160);
  });

  it("never says assistant and never uses an em dash", () => {
    for (const text of strings) {
      expect(text).not.toMatch(/assistant/i);
      expect(text).not.toContain("—");
    }
  });

  it("only lists tools the server registers", () => {
    const known: readonly string[] = MCP_TOOLS;
    for (const item of LOOP) {
      for (const tool of item.tools) expect(known).toContain(tool);
    }
  });

  it("defaults the download to the latest release", () => {
    expect(DOWNLOAD_URL).toBe(`${REPO_URL}/releases/latest`);
  });
});
