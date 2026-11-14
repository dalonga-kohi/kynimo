import Link from "next/link";
import { EchoOnView } from "@/components/EchoOnView";
import { ExposureStudy } from "@/components/ExposureStudy";
import { Footer } from "@/components/Footer";
import { HeroField } from "@/components/HeroField";
import { HeroPlayer } from "@/components/HeroPlayer";
import { LayerStack } from "@/components/LayerStack";
import { ArrowRightIcon } from "@/components/Mark";
import { Nav } from "@/components/Nav";
import { Packs } from "@/components/Packs";
import { BETA_PATH, DOWNLOAD_URL, FAQ, LOOP, REPO_URL, SITE, SITE_URL } from "@/lib/site";

const LICENSE_URL = "https://www.apache.org/licenses/LICENSE-2.0";

const jsonLd = {
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "WebSite",
      "@id": `${SITE_URL}/#website`,
      url: SITE_URL,
      name: SITE.name,
      description: SITE.description,
      inLanguage: "en",
    },
    {
      "@type": "Organization",
      "@id": `${SITE_URL}/#organization`,
      name: SITE.name,
      url: SITE_URL,
      logo: `${SITE_URL}/icon.svg`,
      sameAs: [REPO_URL],
    },
    {
      "@type": "SoftwareApplication",
      "@id": `${SITE_URL}/#software`,
      name: SITE.name,
      url: SITE_URL,
      description: SITE.description,
      applicationCategory: "MultimediaApplication",
      applicationSubCategory: "Motion graphics",
      operatingSystem: "Windows",
      creativeWorkStatus: "Beta",
      downloadUrl: DOWNLOAD_URL,
      license: LICENSE_URL,
      codeRepository: REPO_URL,
      featureList: [
        "Local MCP server for any MCP client",
        "Editable scene document: layers, keyframes, components",
        "Text animators, shape operators, masks, effects and shaders",
        "Deterministic rendering",
        "MP4, WebM and GIF export",
      ],
    },
    {
      "@type": "FAQPage",
      "@id": `${SITE_URL}/#faq`,
      mainEntity: FAQ.map(({ q, a }) => ({
        "@type": "Question",
        name: q,
        acceptedAnswer: { "@type": "Answer", text: a },
      })),
    },
  ],
};

const DESKTOP_FACTS = [
  [
    "Connect in one paste",
    "The Connect screen has ready setup for Claude Code, Codex, Cursor and Claude Desktop.",
  ],
  ["Watch it work", "Every animation your agent makes shows up in the app, ready to play back."],
  ["Export locally", "MP4, WebM and GIF, encoded on your machine with the bundled FFmpeg."],
] as const;

function Arrow() {
  return (
    <svg className="icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" aria-hidden="true">
      <path
        d="M8 3v10M3.5 8.5 8 13l4.5-4.5"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export default function Home() {
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
      <Nav />
      <EchoOnView />

      <main id="main">
        <section className="hero" id="top">
          <HeroField />
          <div className="wrap hero-copy">
            <h1 className="display hero-title">
              <span className="echo">Motion graphics</span> <span>for your AI agent.</span>
            </h1>
            <p className="hero-sub">
              Kynimo is a desktop app that gives Claude, Cursor or any MCP agent a real motion
              engine. Your agent builds the video from layers and keyframes, looks at the frames it
              made, and leaves you a project you can still change.
            </p>
            <div className="hero-actions">
              <Link className="btn btn-primary" href={BETA_PATH}>
                Try the beta
                <ArrowRightIcon />
              </Link>
              <a className="link-down" href="#how">
                See how it works
                <Arrow />
              </a>
            </div>
          </div>
          <div className="wrap hero-stage">
            <HeroPlayer />
            <p className="hero-note">
              A scene document, drawn live in your browser. Drag the timeline.
            </p>
          </div>
        </section>

        <section className="section layers" id="layers" aria-labelledby="layers-title">
          <div className="wrap layers-grid">
            <header className="layers-copy">
              <h2 id="layers-title" data-echo>
                Not a clip. A project.
              </h2>
              <p className="lede">
                Video generators hand you finished pixels. Want a different word? Generate again and
                hope.
              </p>
              <p className="lede">
                Kynimo builds a scene: every layer, keyframe, colour and timing has a name. Your
                agent changes one of them, and every other frame stays exactly as it was.
              </p>
            </header>
            <LayerStack />
          </div>
        </section>

        <section className="section" id="how" aria-labelledby="how-title">
          <div className="wrap">
            <header className="section-head">
              <h2 id="how-title" data-echo>
                What your agent does with it.
              </h2>
              <p className="lede">
                It works like a motion designer with a checklist: build, look, check, fix. Every
                step is a tool call you can read.
              </p>
            </header>
            <ol className="sheet">
              {LOOP.map((item) => (
                <li key={item.step} className="sheet-cell">
                  <h3>{item.step}</h3>
                  <p>{item.body}</p>
                  {item.tools.length > 0 && (
                    <ul className="sheet-tools">
                      {item.tools.map((tool) => (
                        <li key={tool}>
                          <code>{tool}</code>
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
            </ol>
          </div>
        </section>

        <section className="section" id="desktop" aria-labelledby="desktop-title">
          <div className="wrap">
            <header className="section-head">
              <h2 id="desktop-title" data-echo>
                It runs on your machine.
              </h2>
              <p className="lede">
                Kynimo for Windows hosts the engine on your computer. No account, no upload, no
                render queue. Your projects and exports stay in a folder you own.
              </p>
            </header>
            <div className="desktop-tour" />
            <ul className="facts">
              {DESKTOP_FACTS.map(([title, body]) => (
                <li key={title} className="fact">
                  <h3>{title}</h3>
                  <p>{body}</p>
                </li>
              ))}
            </ul>
            <Link className="btn btn-quiet desktop-cta" href={BETA_PATH}>
              Get the Windows beta
              <ArrowRightIcon />
            </Link>
          </div>
        </section>

        <section className="section" id="features" aria-labelledby="features-title">
          <div className="wrap">
            <header className="section-head">
              <h2 id="features-title" data-echo>
                Everything a motion designer reaches for.
              </h2>
              <p className="lede">
                Text animators, shape operators, masks, shaders, cameras. The engine has the depth
                of a professional tool, and your agent can use all of it.
              </p>
            </header>
            <Packs />
          </div>
        </section>

        <section className="section" id="faq" aria-labelledby="faq-title">
          <div className="wrap faq">
            <h2 id="faq-title" data-echo>
              Questions
            </h2>
            <div className="faq-list">
              {FAQ.map(({ q, a }, i) => (
                <details key={q} open={i === 0}>
                  <summary>
                    <h3>{q}</h3>
                  </summary>
                  <p>{a}</p>
                </details>
              ))}
            </div>
          </div>
        </section>

        <section className="close" aria-labelledby="close-title">
          <HeroField variant="close" />
          <div className="wrap close-inner">
            <ExposureStudy />
            <h2 id="close-title" className="display" data-echo>
              Every frame, on purpose.
            </h2>
            <p className="lede">
              A project you can open, read and change. Built by your agent, finished by you.
            </p>
            <div className="close-actions">
              <Link className="btn btn-primary" href={BETA_PATH}>
                Try the beta
                <ArrowRightIcon />
              </Link>
              <a className="link-quiet" href={REPO_URL} rel="noopener">
                View the source on GitHub
              </a>
            </div>
          </div>
        </section>
      </main>

      <Footer />
    </>
  );
}
