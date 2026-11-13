import { describe, expect, it } from "vitest";
import {
  FEEDBACK_PREFIX,
  feedbackUrl,
  isFeedbackUrl,
  sanitizeFileName,
  stdioConfig,
} from "./external.js";

describe("feedbackUrl", () => {
  it("is a new-issue URL carrying the version, Windows, server state and the two questions", () => {
    const url = feedbackUrl({
      appVersion: "0.1.0",
      osVersion: "10.0.26200",
      status: { server: "running", port: 8788 },
    });
    expect(isFeedbackUrl(url)).toBe(true);
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe(
      "https://github.com/dalonga-kohi/kynimo/issues/new",
    );
    const body = parsed.searchParams.get("body") ?? "";
    expect(body).toContain("Kynimo 0.1.0");
    expect(body).toContain("Windows 10.0.26200");
    expect(body).toContain("Server: running on port 8788");
    expect(body).toContain("**What happened**");
    expect(body).toContain("**What you expected**");
    expect(parsed.searchParams.get("title")).toBeTruthy();
  });

  it("reports a failed server with its message", () => {
    const url = feedbackUrl({
      appVersion: "1",
      osVersion: "1",
      status: { server: "failed", error: "EACCES" },
    });
    expect(new URL(url).searchParams.get("body")).toContain("Server: failed: EACCES");
  });

  it("only recognizes its own prefix", () => {
    expect(isFeedbackUrl(`${FEEDBACK_PREFIX}title=x`)).toBe(true);
    expect(isFeedbackUrl("https://github.com/dalonga-kohi/kynimo/issues")).toBe(false);
    expect(
      isFeedbackUrl("https://evil.example/?https://github.com/dalonga-kohi/kynimo/issues/new?"),
    ).toBe(false);
    expect(isFeedbackUrl("file:///C:/Windows/System32/calc.exe")).toBe(false);
  });
});

describe("stdioConfig", () => {
  it("launches the bridge through the app executable in node mode", () => {
    const config = JSON.parse(stdioConfig("C:\\Kynimo\\Kynimo.exe", "C:\\Kynimo\\bridge.mjs"));
    expect(config).toEqual({
      mcpServers: {
        kynimo: {
          command: "C:\\Kynimo\\Kynimo.exe",
          args: ["C:\\Kynimo\\bridge.mjs"],
          env: { ELECTRON_RUN_AS_NODE: "1" },
        },
      },
    });
  });
});

describe("sanitizeFileName", () => {
  it.each([
    ["Launch video", "Launch video"],
    ['a<b>c:d"e/f\\g|h?i*j', "a-b-c-d-e-f-g-h-i-j"],
    ["  spaced   out  ", "spaced out"],
    ["trailing dots...", "trailing dots"],
    ["", "animation"],
    ["???", "animation"],
    ["CON", "CON_"],
    ["nul.final", "nul.final_"],
    ["x".repeat(300), "x".repeat(100)],
    ["tab\tname", "tab-name"],
  ])("%j becomes %j", (name, expected) => {
    expect(sanitizeFileName(name)).toBe(expected);
  });
});
