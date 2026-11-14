import { fileURLToPath } from "node:url";

const desktop = fileURLToPath(new URL(".", import.meta.url));
const stage = (path) => `${desktop}build/stage/${path}`;

/**
 * electron-builder configuration for the Windows installer. scripts/package.mjs fills
 * build/stage/ first: app/ (a flat production install plus out/), and resources/ (media,
 * browsers, notices). `electronVersion` and `electronDist` are passed in by that script.
 */
export default {
  appId: "dev.kynimo.desktop",
  productName: "Kynimo",
  copyright: "Kynimo",
  directories: { app: stage("app"), output: `${desktop}dist`, buildResources: `${desktop}build` },
  // The app has no native modules; its Chromium for capture is Playwright's, in resources/browsers.
  npmRebuild: false,
  nodeGypRebuild: false,
  buildDependenciesFromSource: false,
  // The app's own code (out/) lives in app.asar. Everything under node_modules is unpacked: the
  // server's packages read their own files at runtime (script worker, CanvasKit wasm, bundled
  // fonts, Playwright's driver) and spawn processes from them, which an archive does not serve.
  asar: true,
  asarUnpack: ["node_modules/**"],
  extraResources: [
    { from: stage("resources/media"), to: "media" },
    { from: stage("resources/browsers"), to: "browsers" },
    { from: stage("resources/notices"), to: "notices" },
    { from: `${desktop}out/main/bridge.mjs`, to: "bridge.mjs" },
  ],
  win: {
    target: [{ target: "nsis", arch: ["x64"] }],
    icon: `${desktop}build/icon.ico`,
    requestedExecutionLevel: "asInvoker",
  },
  // An assisted, branded wizard that still installs per user (no UAC prompt). A fully custom
  // installer UI is a follow-up.
  nsis: {
    oneClick: false,
    perMachine: false,
    allowElevation: false,
    allowToChangeInstallationDirectory: false,
    // English only, whatever the system language: the wording is part of the beta.
    language: "1033",
    multiLanguageInstaller: false,
    runAfterFinish: true,
    installerIcon: `${desktop}build/icon.ico`,
    uninstallerIcon: `${desktop}build/icon.ico`,
    installerHeaderIcon: `${desktop}build/icon.ico`,
    installerSidebar: `${desktop}build/installer-sidebar.bmp`,
    uninstallerSidebar: `${desktop}build/installer-sidebar.bmp`,
    installerHeader: `${desktop}build/installer-header.bmp`,
    include: `${desktop}build/installer.nsh`,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    shortcutName: "Kynimo",
    // electron-builder expands ${version} itself.
    // biome-ignore lint/suspicious/noTemplateCurlyInString: not a template literal.
    artifactName: "Kynimo-Setup-${version}.exe",
    deleteAppDataOnUninstall: false,
  },
  publish: null,
};
