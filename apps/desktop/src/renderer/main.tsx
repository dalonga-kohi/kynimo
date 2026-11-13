import "@fontsource-variable/mona-sans/wdth.css";
import "@fontsource-variable/geist-mono";
import { createRoot } from "react-dom/client";
import { App, type Initial } from "./App.js";
import "./styles/tokens.css";
import "./styles/global.css";
import "./components/Button.css";

// Set by the browser-only build (`pnpm dev:web`); false in the app, so the mock is not bundled.
declare const __KYNIMO_MOCK__: boolean;

async function boot(): Promise<void> {
  let initial: Initial | undefined;
  if (__KYNIMO_MOCK__ && window.kynimo === undefined) {
    const { installMock } = await import("./mock/install.js");
    initial = installMock(window.location.search);
  }
  const root = document.getElementById("root");
  if (root) createRoot(root).render(<App {...(initial === undefined ? {} : { initial })} />);
}

void boot();
