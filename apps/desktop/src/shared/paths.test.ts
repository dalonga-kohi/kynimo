import { describe, expect, it } from "vitest";
import { dataDir, displayDir } from "./paths.js";

const windows = {
  platform: "win32" as const,
  home: "C:\\Users\\Ada",
  env: { LOCALAPPDATA: "C:\\Users\\Ada\\AppData\\Local" },
};

describe("dataDir", () => {
  it("is %LOCALAPPDATA%\\Kynimo on Windows", () => {
    expect(dataDir(windows)).toBe("C:\\Users\\Ada\\AppData\\Local\\Kynimo");
  });

  it("falls back to AppData\\Local under home when LOCALAPPDATA is unset or relative", () => {
    expect(dataDir({ ...windows, env: {} })).toBe("C:\\Users\\Ada\\AppData\\Local\\Kynimo");
    expect(dataDir({ ...windows, env: { LOCALAPPDATA: "relative" } })).toBe(
      "C:\\Users\\Ada\\AppData\\Local\\Kynimo",
    );
  });

  it("matches the other platforms of scripts/local/launch.mjs", () => {
    expect(dataDir({ platform: "darwin", home: "/Users/ada", env: {} })).toBe(
      "/Users/ada/Library/Application Support/Kynimo",
    );
    expect(dataDir({ platform: "linux", home: "/home/ada", env: {} })).toBe(
      "/home/ada/.local/share/kynimo",
    );
    expect(dataDir({ platform: "linux", home: "/home/ada", env: { XDG_DATA_HOME: "/data" } })).toBe(
      "/data/kynimo",
    );
  });
});

describe("displayDir", () => {
  it("shows the Windows default as %LOCALAPPDATA%\\Kynimo", () => {
    expect(displayDir(dataDir(windows), windows)).toBe("%LOCALAPPDATA%\\Kynimo");
  });

  it("shows any other folder as it is", () => {
    expect(displayDir("D:\\Videos\\Kynimo", windows)).toBe("D:\\Videos\\Kynimo");
    expect(displayDir("/home/ada/.local/share/kynimo", { ...windows, platform: "linux" })).toBe(
      "/home/ada/.local/share/kynimo",
    );
  });
});
