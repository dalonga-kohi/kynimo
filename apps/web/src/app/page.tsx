import { Connect } from "@/components/Connect";
import { EchoOnView } from "@/components/EchoOnView";
import { ExposureStudy } from "@/components/ExposureStudy";
import { HeroField } from "@/components/HeroField";
import { HeroPlayer } from "@/components/HeroPlayer";
import { LayerStack } from "@/components/LayerStack";
import { GitHubIcon, Mark } from "@/components/Mark";
import { Nav } from "@/components/Nav";
import { Packs } from "@/components/Packs";
import { FAQ, LOOP, REPO_URL, SITE, SITE_URL, STATUS } from "@/lib/site";

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
      "@type": "SoftwareApplication",
      "@id": `${SITE_URL}/#software`,
      name: SITE.name,
      url: SITE_URL,
      description: SITE.description,
      applicationCategory: "MultimediaApplication",
      applicationSubCategory: "Motion graphics",
      operatingSystem: "Web",
      creativeWorkStatus: "In development",
      codeRepository: REPO_URL,
      featureList: [
        "Remote MCP server for any MCP client",
        "Editable scene document: layers, keyframes, components",
        "Style packs, with automatic quality checks planned",
        "Deterministic rendering",
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

const ROADMAP = [
  ...STATUS.built.map(([name, body]) => ({ name, body, done: true })),
  ...STATUS.next.map(([name, body]) => ({ name, body, done: false })),
];
/** Where the Today line sits on every track: after the last built milestone. */
const TODAY = STATUS.built.length / ROADMAP.length;

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
              Kynimo is an MCP server that gives Claude, Cursor or any assistant a real motion
              engine. It builds the video from layers and keyframes, looks at the frames it made,
              and hands you a project you can still change.
            </p>
            <div className="hero-actions">
              <a className="btn btn-primary" href={REPO_URL} rel="noopener">
                <GitHubIcon />
                Follow on GitHub
              </a>
              <a className="link-down" href="#connect">
                Connect your assistant
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
                assistant changes one of them, and every other frame stays exactly as it was.
              </p>
            </header>
            <LayerStack />
          </div>
        </section>

        <section className="section" id="how" aria-labelledby="how-title">
          <div className="wrap">
            <header className="section-head">
              <h2 id="how-title" data-echo>
                What your assistant does with it.
              </h2>
              <p className="lede">
                It works like a motion designer with a checklist: build, look, check, fix. Every
                step is a tool call you can read.
              </p>
            </header>
            <ol className="sheet">
              {LOOP.map((item, i) => (
                <li key={item.step} className="sheet-cell" data-next={item.next}>
                  <span className="sheet-frame">f{String(i * 30).padStart(3, "0")}</span>
                  <h3>
                    {item.step}
                    {item.next && <span className="soon">Next</span>}
                  </h3>
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

        <section className="section" id="connect" aria-labelledby="connect-title">
          <div className="wrap connect-wrap">
            <header className="section-head center">
              <h2 id="connect-title" data-echo>
                One line to connect.
              </h2>
              <p className="lede">
                Kynimo runs in the cloud. Add the server, sign in once in your browser, and ask for
                a video. No install, no API keys to paste.
              </p>
            </header>
            <Connect />
          </div>
        </section>

        <section className="section" id="styles" aria-labelledby="styles-title">
          <div className="wrap">
            <header className="section-head">
              <h2 id="styles-title" data-echo>
                Four styles. Four different films.
              </h2>
              <p className="lede">
                A style pack is a motion design system: typeface, palette, springs and timing. Same
                engine, same ten seconds, and each pack moves like nothing else on the list.
              </p>
            </header>
            <Packs />
          </div>
        </section>

        <section className="section" id="roadmap" aria-labelledby="roadmap-title">
          <div className="wrap">
            <header className="section-head">
              <h2 id="roadmap-title" data-echo>
                Built in the open.
              </h2>
              <p className="lede">
                No launch countdown. Here is what runs today and what comes next, in order.
              </p>
            </header>
            <ol className="roadmap" style={{ "--today": TODAY } as React.CSSProperties}>
              <li className="roadmap-head" aria-hidden="true">
                <span>Runs today</span>
                <span className="roadmap-lane">
                  <b>Today</b>
                  <span>Next</span>
                </span>
              </li>
              {ROADMAP.map((item, i) => (
                <li key={item.name} className="milestone" data-done={item.done}>
                  <div className="milestone-text">
                    <h3>{item.name}</h3>
                    <p>{item.body}</p>
                    <span className="sr-only">{item.done ? "Built." : "Planned."}</span>
                  </div>
                  <span className="roadmap-lane" aria-hidden="true">
                    <span
                      className="milestone-clip"
                      style={{ "--at": i / ROADMAP.length } as React.CSSProperties}
                    >
                      <i />
                    </span>
                  </span>
                </li>
              ))}
            </ol>
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
              Every decision is written down. Every milestone lands in the repository.
            </p>
            <a className="btn btn-primary" href={REPO_URL} rel="noopener">
              <GitHubIcon />
              Follow on GitHub
            </a>
          </div>
        </section>
      </main>

      <footer className="footer">
        <div className="wrap footer-inner">
          <a className="lockup" href="#top" aria-label="Kynimo, back to top">
            <Mark className="lockup-mark" />
            <span>Kynimo</span>
          </a>
          <p>Every scene on this page is illustrative and drawn live in your browser.</p>
          <nav aria-label="Footer">
            <a href={REPO_URL} rel="noopener">
              GitHub
            </a>
            <a href="/llms.txt">llms.txt</a>
            <span>© 2026 Kynimo</span>
          </nav>
        </div>
      </footer>
    </>
  );
}
