// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { KynimoApi } from "../shared/api.js";
import { App } from "./App.js";
import { setClock } from "./lib/clock.js";
import { setOverrides } from "./lib/overrides.js";
import { createMockApi, initialFor, MOCK_NOW, NIMBUS_ID, parseScenario } from "./mock/api.js";

let api: KynimoApi;

/** Mounts the app over the mock API, starting on the screen the scenario names. */
function mount(query: string, tweak?: (api: KynimoApi) => void) {
  const scenario = parseScenario(`?${query}`);
  api = createMockApi(scenario);
  tweak?.(api);
  window.kynimo = api;
  return render(<App initial={initialFor(scenario)} />);
}

/** Mounts the app the way Electron does: the first launch decides where it starts. */
function mountStartup(query: string, tweak?: (api: KynimoApi) => void) {
  api = createMockApi(parseScenario(`?${query}`));
  tweak?.(api);
  window.kynimo = api;
  return render(<App />);
}

beforeEach(() => {
  setClock(() => MOCK_NOW);
  setOverrides({});
  HTMLMediaElement.prototype.play = vi.fn(() => Promise.resolve());
  HTMLMediaElement.prototype.pause = vi.fn();
});
afterEach(() => cleanup());

describe("start-up routing", () => {
  it("shows Welcome on first launch, with the build version and projects folder", async () => {
    mountStartup("screen=welcome");
    expect(await screen.findByRole("heading", { name: /You're early/ })).toBeInTheDocument();
    expect(screen.getByText("PRIVATE BETA · BUILD 0.1.0")).toBeInTheDocument();
    expect(screen.getByText("Projects live in %LOCALAPPDATA%\\Kynimo")).toBeInTheDocument();
  });

  it("opens Animations when there are animations, Connect when there are none", async () => {
    const first = mountStartup("screen=animations");
    expect(await screen.findByRole("heading", { name: "Animations" })).toBeInTheDocument();
    first.unmount();
    mountStartup("screen=connect");
    expect(
      await screen.findByRole("heading", { name: "One line to connect." }),
    ).toBeInTheDocument();
  });
});

describe("start-up while the server starts", () => {
  it("waits for the server before deciding, then shows Welcome", async () => {
    let ready = false;
    let changed: () => void = () => undefined;
    mountStartup("screen=welcome", (a) => {
      const status = a.studio.status;
      a.studio.status = async () => ({
        ...(await status()),
        server: ready ? "running" : "starting",
      });
      a.studio.welcomeSeen = async () => {
        if (!ready) throw new Error("the server is still starting");
        return false;
      };
      a.studio.onChanged = (callback) => {
        changed = callback;
        return () => undefined;
      };
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByRole("heading", { name: /You're early/ })).not.toBeInTheDocument();
    ready = true;
    changed();
    expect(await screen.findByRole("heading", { name: /You're early/ })).toBeInTheDocument();
  });

  it("goes to Connect when the server failed to start", async () => {
    mountStartup("screen=welcome", (a) => {
      a.studio.status = async () => ({
        server: "failed",
        error: "port in use",
        dataDir: "x",
        projectsDir: "x",
        startedAt: MOCK_NOW,
      });
      a.studio.welcomeSeen = async () => {
        throw new Error("the server is not running");
      };
    });
    expect(await screen.findByText("Server stopped: port in use")).toBeInTheDocument();
  });
});

describe("Welcome", () => {
  it("marks the welcome seen and goes on to Connect", async () => {
    mount("screen=welcome");
    const spy = vi.spyOn(api.studio, "markWelcomeSeen");
    fireEvent.click(await screen.findByRole("button", { name: /Connect your agent/ }));
    expect(spy).toHaveBeenCalledTimes(1);
    expect(
      await screen.findByRole("heading", { name: "One line to connect." }),
    ).toBeInTheDocument();
    expect(await api.studio.welcomeSeen()).toBe(true);
  });

  it("opens the build notes, and Esc closes them", async () => {
    mount("screen=welcome");
    fireEvent.click(await screen.findByRole("button", { name: "What's in this build" }));
    const dialog = await screen.findByRole("dialog", { name: "What's in this build" });
    expect(within(dialog).getByText("BUILD 0.1.0")).toBeInTheDocument();
    expect(within(dialog).getByText("Known rough edges")).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });
});

describe("Connect", () => {
  it("switches the code with the client tab and copies what is shown", async () => {
    mount("screen=connect");
    const write = vi.spyOn(api.clipboard, "writeText");
    expect(await screen.findByText(/claude mcp add --transport http kynimo/)).toHaveTextContent(
      "claude mcp add --transport http kynimo http://127.0.0.1:8787/mcp",
    );

    fireEvent.click(screen.getByRole("tab", { name: "Cursor" }));
    expect(screen.getByText("~/.cursor/mcp.json")).toBeInTheDocument();
    expect(screen.getByText(/"mcpServers"/)).toHaveTextContent(
      '"url": "http://127.0.0.1:8787/mcp"',
    );

    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    expect(write).toHaveBeenCalledWith(
      JSON.stringify({ mcpServers: { kynimo: { url: "http://127.0.0.1:8787/mcp" } } }, null, 2),
    );
    expect(screen.getByRole("button", { name: "Copied" })).toBeInTheDocument();
  });

  it("shows the stdio bridge config for Claude Desktop", async () => {
    mount("screen=connect");
    fireEvent.click(await screen.findByRole("tab", { name: "Claude Desktop" }));
    await waitFor(() => expect(screen.getByText(/ELECTRON_RUN_AS_NODE/)).toBeInTheDocument());
    expect(screen.getByText("claude_desktop_config.json")).toBeInTheDocument();
  });

  it("waits for an agent with the elapsed time since the server started", async () => {
    mount("screen=connect&client=none");
    expect(await screen.findByText("Waiting for your agent")).toBeInTheDocument();
    expect(screen.getByText("00:00:14")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("127.0.0.1:8787");
  });

  it("shows who connected, with the time of the first request frozen", async () => {
    mount("screen=connect&client=claude");
    expect(
      await screen.findByRole("heading", { name: "Claude Code connected" }),
    ).toBeInTheDocument();
    expect(screen.getByText("00:01:00")).toBeInTheDocument();
    expect(screen.queryByText("Waiting for your agent")).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Claude Code connected");
  });

  it("shows a stopped server", async () => {
    mount("screen=connect", (a) => {
      a.studio.status = async () => ({
        server: "failed",
        error: "port in use",
        dataDir: "x",
        projectsDir: "x",
        startedAt: MOCK_NOW,
      });
    });
    expect(await screen.findByText("Server stopped: port in use")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Server stopped");
  });

  it("opens the stdio help", async () => {
    mount("screen=connect");
    const spy = vi.spyOn(api, "openStdioHelp");
    fireEvent.click(await screen.findByRole("button", { name: "Use stdio instead" }));
    expect(spy).toHaveBeenCalled();
  });
});

describe("Animations", () => {
  it("lists the six animations with the rendering one marked", async () => {
    mount("screen=animations");
    expect(await screen.findAllByText("Nimbus 2 product reveal")).not.toHaveLength(0);
    expect(screen.getAllByRole("listitem")).toHaveLength(6);
    expect(screen.getByText("6 scenes · 1m 04s")).toBeInTheDocument();
    expect(screen.getByText("Rendering frames · 62%")).toBeInTheDocument();
    expect(screen.getByText("Claude Code is rendering · just now")).toBeInTheDocument();
    expect(screen.getByText("Codex · 2 hours ago")).toBeInTheDocument();
    expect(screen.getByText("Claude Code · yesterday")).toBeInTheDocument();
    expect(screen.getByText("Cursor · Nov 11")).toBeInTheDocument();
    expect(screen.getByText("00:12")).toBeInTheDocument();
  });

  it("says the checking state in the sub-line only", async () => {
    mount("screen=animations", (a) => {
      const list = a.studio.listAnimations;
      a.studio.listAnimations = async () =>
        (await list()).map((x, i) =>
          i === 0 ? { ...x, activity: { kind: "checking", client: "Codex" } } : x,
        );
    });
    expect(await screen.findByText("Codex is checking frames · just now")).toBeInTheDocument();
    expect(screen.queryByText(/Rendering frames/)).not.toBeInTheDocument();
  });

  it("falls back to the name until the thumbnail loads", async () => {
    mount("screen=animations");
    const card = (await screen.findByRole("button", { name: /Friday deploys promo/ })).closest(
      "li",
    ) as HTMLElement;
    expect(within(card).getAllByText("Friday deploys promo").length).toBeGreaterThanOrEqual(2);
    const img = card.querySelector("img") as HTMLImageElement;
    expect(img.src).toBe("mock://thumb/p-00000000000000000000000000000003/2");
    fireEvent.load(img);
    expect(within(card).getAllByText("Friday deploys promo")).toHaveLength(1);
  });

  it("sorts with the dropdown", async () => {
    mount("screen=animations");
    const titles = () =>
      screen.getAllByRole("listitem").map((li) => li.querySelector(".card__title")?.textContent);
    await screen.findAllByText("Nimbus 2 product reveal");
    expect(titles()[0]).toBe("Launch week title card");
    fireEvent.click(screen.getByRole("button", { name: /Latest first/ }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Name A–Z" }));
    expect(titles()[0]).toBe("Black Friday bumper");
    fireEvent.click(screen.getByRole("button", { name: /Name A–Z/ }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Oldest first" }));
    expect(titles()[0]).toBe("Q3 numbers for the all-hands");
  });

  it("shows an empty state that leads to Connect", async () => {
    mount("screen=empty");
    expect(await screen.findByRole("heading", { name: "Nothing here yet." })).toBeInTheDocument();
    expect(
      screen.getByText("Ask your agent for a video. It shows up here as soon as it's built."),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Connect your agent" }));
    expect(
      await screen.findByRole("heading", { name: "One line to connect." }),
    ).toBeInTheDocument();
  });

  it("opens the projects folder", async () => {
    mount("screen=animations");
    const spy = vi.spyOn(api.studio, "openProjectsFolder");
    fireEvent.click(await screen.findByRole("button", { name: "Open folder" }));
    expect(spy).toHaveBeenCalled();
  });
});

describe("Player", () => {
  async function openNimbus() {
    mount("screen=animations");
    fireEvent.click(await screen.findByRole("button", { name: /Nimbus 2 product reveal/ }));
    return screen.findByRole("heading", { level: 1, name: "Nimbus 2 product reveal" });
  }

  it("shows the facts of the animation", async () => {
    await openNimbus();
    const row = (name: string) => screen.getByText(name).closest("div") as HTMLElement;
    expect(within(row("Style")).getByText("Keynote")).toBeInTheDocument();
    expect(within(row("Length")).getByText("12 s")).toBeInTheDocument();
    expect(within(row("Size")).getByText("1920×1080 · 30 fps")).toBeInTheDocument();
    expect(within(row("Layers")).getByText("4")).toBeInTheDocument();
    expect(screen.getByText("Made by Codex · 2 hours ago")).toBeInTheDocument();
    expect(screen.getByText("nimbus-reveal")).toBeInTheDocument();
    expect(screen.getByText("00:00:00")).toBeInTheDocument();
    expect(screen.getByText(/00:12:00/)).toBeInTheDocument();
    expect(screen.getByText("Preparing preview…")).toBeInTheDocument();
  });

  it("draws one timeline row per layer", async () => {
    await openNimbus();
    for (const name of ["background", "glow", "title", "subtitle"])
      expect(screen.getByRole("button", { name })).toBeInTheDocument();
    expect(document.querySelectorAll(".row__key")).toHaveLength(5);
  });

  it("names the second layer in the example request", async () => {
    await openNimbus();
    expect(screen.getByText("“Bring the glow in half a second later.”")).toBeInTheDocument();
  });

  it("starts the video preview from the preview URL and plays with the button and Space", async () => {
    await openNimbus();
    const video = document.querySelector("video") as HTMLVideoElement;
    expect(video.getAttribute("src")).toBe(`mock://preview/${NIMBUS_ID}/5`);
    expect(video).toHaveAttribute("preload", "auto");
    fireEvent.canPlay(video);
    await waitFor(() => expect(screen.queryByText("Preparing preview…")).not.toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "Play" }));
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(1);
    fireEvent.play(video);
    expect(await screen.findByRole("button", { name: "Pause" })).toBeInTheDocument();

    // jsdom never starts playback: say the video is playing.
    Object.defineProperty(video, "paused", { value: false, configurable: true });
    (HTMLMediaElement.prototype.play as ReturnType<typeof vi.fn>).mockClear();
    fireEvent.keyDown(document.body, { key: " " });
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(0);
    expect(HTMLMediaElement.prototype.pause).toHaveBeenCalled();
  });

  it("leaves Space alone while typing in a field", async () => {
    await openNimbus();
    const input = document.createElement("input");
    document.body.append(input);
    fireEvent.keyDown(input, { key: " " });
    expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();
    input.remove();
  });

  it("exports MP4 and shows it saved", async () => {
    await openNimbus();
    const spy = vi.spyOn(api.studio, "exportVideo").mockResolvedValue({
      status: "saved",
      file: "C:\\out.mp4",
    });
    fireEvent.click(screen.getByRole("button", { name: "Export MP4" }));
    expect(spy).toHaveBeenCalledWith(NIMBUS_ID, "mp4");
    expect(await screen.findByRole("button", { name: "Saved" })).toBeInTheDocument();
  });

  it("exports WebM and GIF from the dropdown", async () => {
    await openNimbus();
    const spy = vi.spyOn(api.studio, "exportVideo").mockResolvedValue({ status: "cancelled" });
    fireEvent.click(screen.getByRole("button", { name: /WebM, GIF/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: "GIF" }));
    expect(spy).toHaveBeenCalledWith(NIMBUS_ID, "gif");
    await waitFor(() => expect(screen.getByRole("button", { name: "Export MP4" })).toBeEnabled());
  });

  it("shows progress while exporting, and a failure under the buttons", async () => {
    await openNimbus();
    let finish: (v: { status: "failed"; error: string }) => void = () => undefined;
    vi.spyOn(api.studio, "exportVideo").mockReturnValue(new Promise((r) => (finish = r)));
    vi.spyOn(api.studio, "exportProgress").mockResolvedValue({ progress: 0.4 });
    fireEvent.click(screen.getByRole("button", { name: "Export MP4" }));
    const busy = await screen.findByRole("button", { name: "Exporting…" });
    expect(busy).toBeDisabled();
    await waitFor(() => expect(busy.querySelector(".export__fill")).toHaveStyle({ width: "40%" }), {
      timeout: 2000,
    });
    finish({ status: "failed", error: "encoder crashed" });
    expect(await screen.findByRole("alert")).toHaveTextContent("encoder crashed");
    expect(screen.getByRole("button", { name: "Export MP4" })).toBeEnabled();
  });

  it("goes back to Animations from the breadcrumb", async () => {
    await openNimbus();
    const crumb = screen.getByRole("navigation", { name: "Breadcrumb" });
    fireEvent.click(within(crumb).getByRole("button", { name: "Animations" }));
    expect(await screen.findByRole("heading", { name: "Animations" })).toBeInTheDocument();
  });
});

describe("title bar", () => {
  it("switches between the tabs", async () => {
    mount("screen=animations");
    const nav = await screen.findByRole("navigation", { name: "Main" });
    fireEvent.click(within(nav).getByRole("button", { name: "Connect" }));
    expect(
      await screen.findByRole("heading", { name: "One line to connect." }),
    ).toBeInTheDocument();
    expect(within(nav).getByRole("button", { name: "Connect" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    fireEvent.click(within(nav).getByRole("button", { name: "Animations" }));
    expect(await screen.findByRole("heading", { name: "Animations" })).toBeInTheDocument();
  });

  it("drives the window", async () => {
    mount("screen=animations");
    const win = api.window;
    const min = vi.spyOn(win, "minimize");
    const max = vi.spyOn(win, "toggleMaximize");
    const close = vi.spyOn(win, "close");
    fireEvent.click(await screen.findByRole("button", { name: "Minimize" }));
    fireEvent.click(screen.getByRole("button", { name: "Maximize" }));
    expect(await screen.findByRole("button", { name: "Restore" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(min).toHaveBeenCalled();
    expect(max).toHaveBeenCalled();
    expect(close).toHaveBeenCalled();
  });

  it("starts maximized when the window is", async () => {
    mount("screen=animations&maximized=1");
    expect(await screen.findByRole("button", { name: "Restore" })).toBeInTheDocument();
  });
});

describe("Help menu", () => {
  async function openHelp() {
    const button = await screen.findByRole("button", { name: "Help" });
    fireEvent.click(button);
    return screen.findByRole("menu", { name: "Help" });
  }

  it("lists the five items", async () => {
    mount("screen=animations");
    const menu = await openHelp();
    expect(
      within(menu)
        .getAllByRole("menuitem")
        .map((i) => i.textContent),
    ).toEqual([
      "About the beta",
      "What's in this build",
      "Send feedback",
      "Use stdio instead",
      "Open projects folder",
      "Third-party notices",
    ]);
  });

  it("calls the matching API for each item", async () => {
    mount("screen=animations");
    const feedback = vi.spyOn(api, "openFeedback");
    const stdio = vi.spyOn(api, "openStdioHelp");
    const folder = vi.spyOn(api.studio, "openProjectsFolder");

    fireEvent.click(within(await openHelp()).getByRole("menuitem", { name: "Send feedback" }));
    expect(feedback).toHaveBeenCalledTimes(1);
    fireEvent.click(within(await openHelp()).getByRole("menuitem", { name: "Use stdio instead" }));
    expect(stdio).toHaveBeenCalledTimes(1);
    fireEvent.click(
      within(await openHelp()).getByRole("menuitem", { name: "Open projects folder" }),
    );
    expect(folder).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();

    const notices = vi.spyOn(api, "openNotices");
    fireEvent.click(
      within(await openHelp()).getByRole("menuitem", { name: "Third-party notices" }),
    );
    expect(notices).toHaveBeenCalledTimes(1);
  });

  it("shows the Welcome screen again and opens the build notes", async () => {
    mount("screen=animations");
    fireEvent.click(
      within(await openHelp()).getByRole("menuitem", { name: "What's in this build" }),
    );
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });
    fireEvent.click(within(await openHelp()).getByRole("menuitem", { name: "About the beta" }));
    expect(await screen.findByRole("heading", { name: /You're early/ })).toBeInTheDocument();
  });

  it("moves with the arrow keys and closes with Esc or an outside click", async () => {
    mount("screen=animations");
    const menu = await openHelp();
    const items = within(menu).getAllByRole("menuitem");
    expect(items[0]).toHaveFocus();
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(items[1]).toHaveFocus();
    fireEvent.keyDown(menu, { key: "ArrowUp" });
    fireEvent.keyDown(menu, { key: "ArrowUp" });
    expect(items.at(-1)).toHaveFocus();
    fireEvent.keyDown(menu, { key: "Home" });
    expect(items[0]).toHaveFocus();
    fireEvent.keyDown(menu, { key: "Escape" });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Help" })).toHaveFocus();

    await openHelp();
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });
});
