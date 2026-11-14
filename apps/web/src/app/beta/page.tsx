import type { Metadata } from "next";
import { Footer } from "@/components/Footer";
import { DownloadIcon } from "@/components/Mark";
import { Nav } from "@/components/Nav";
import { BETA_PATH, DOWNLOAD_URL, ISSUES_URL, SITE, SITE_URL } from "@/lib/site";

const title = "Download the Windows beta";
const description =
  "Download Kynimo for Windows. A private beta of the desktop motion graphics engine your AI agent drives over MCP. No account needed.";

export const metadata: Metadata = {
  title,
  description,
  alternates: { canonical: BETA_PATH },
  openGraph: { type: "website", url: BETA_PATH, title, description },
};

const jsonLd = {
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "SoftwareApplication",
      "@id": `${SITE_URL}/#software`,
      name: SITE.name,
      url: `${SITE_URL}${BETA_PATH}`,
      description,
      applicationCategory: "MultimediaApplication",
      operatingSystem: "Windows",
      downloadUrl: DOWNLOAD_URL,
      license: "https://www.apache.org/licenses/LICENSE-2.0",
    },
    {
      "@type": "BreadcrumbList",
      itemListElement: [
        { "@type": "ListItem", position: 1, name: "Home", item: `${SITE_URL}/` },
        { "@type": "ListItem", position: 2, name: "Beta", item: `${SITE_URL}${BETA_PATH}` },
      ],
    },
  ],
};

const STEPS = [
  [
    "Install",
    "Run the installer. It installs for your user only, with no administrator prompt. Windows SmartScreen will warn you because the build is unsigned: choose More info, then Run anyway.",
  ],
  [
    "Connect your agent",
    "Open the Connect screen. It shows the local MCP address and ready setup for Claude Code, Codex, Cursor and Claude Desktop. Paste it into your client.",
  ],
  [
    "Ask for a video",
    "Describe what you want. Your agent builds the scene, and the animation appears in the app, ready to play back and export.",
  ],
] as const;

const INCLUDED = [
  [
    "The full engine",
    "Layers, bezier and spring keyframes, text animators, shape operators, masks, effects, cameras and shaders.",
  ],
  ["Local MCP server", "Starts with the app. Works with any MCP client, over HTTP or stdio."],
  ["Playback", "Every animation in your projects, with a player and a timeline."],
  ["Export", "MP4, WebM and GIF, rendered on your machine."],
] as const;

const MISSING = [
  "Editing in the app. For now your agent makes the changes.",
  "Style packs and the automatic quality report.",
  "Signed installers and automatic updates.",
  "macOS and Linux builds.",
] as const;

export default function Beta() {
  return (
    <>
      <script
        type="application/ld+json"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: static JSON-LD built from constants above
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd).replace(/</g, "\\u003c") }}
      />
      <a className="skip" href="#main">
        Skip to content
      </a>
      <Nav home={false} />

      <main id="main">
        <div className="wrap beta">
          <header className="beta-head">
            <p className="beta-eyebrow">Private beta · Windows</p>
            <h1 className="display beta-title">Kynimo for Windows.</h1>
            <p className="lede">
              The desktop app that hosts Kynimo's motion engine on your computer and shows what your
              agent makes. It is an early build: it works, and it has rough edges.
            </p>
            <div className="beta-download">
              <a className="btn btn-primary" href={DOWNLOAD_URL} rel="noopener">
                <DownloadIcon />
                Download for Windows
              </a>
              <p className="beta-meta">64-bit · about 270 MB · installer is not code signed yet</p>
            </div>
          </header>

          <section className="beta-section" aria-labelledby="start-title">
            <h2 id="start-title">Get started</h2>
            <ol className="beta-steps">
              {STEPS.map(([name, body], i) => (
                <li key={name} className="beta-step">
                  <span className="beta-num">{i + 1}</span>
                  <div>
                    <h3>{name}</h3>
                    <p>{body}</p>
                  </div>
                </li>
              ))}
            </ol>
          </section>

          <section className="beta-section" aria-labelledby="included-title">
            <h2 id="included-title">What is in the beta</h2>
            <ul className="beta-grid">
              {INCLUDED.map(([name, body]) => (
                <li key={name} className="beta-item">
                  <h3>{name}</h3>
                  <p>{body}</p>
                </li>
              ))}
            </ul>
          </section>

          <section className="beta-section" aria-labelledby="missing-title">
            <h2 id="missing-title">Not there yet</h2>
            <ul className="beta-list">
              {MISSING.map((item) => (
                <li key={item} className="beta-line">
                  {item}
                </li>
              ))}
            </ul>
          </section>

          <p className="beta-foot">
            Found a bug or have an idea?{" "}
            <a href={ISSUES_URL} rel="noopener">
              Open an issue on GitHub
            </a>
            .
          </p>
          <p className="beta-foot">Your projects stay on your disk when you uninstall.</p>
        </div>
      </main>

      <Footer home={false} />
    </>
  );
}
