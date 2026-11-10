import { Connect, ToolTicker } from "@/components/Connect";
import { Editable } from "@/components/Editable";
import { HeroField } from "@/components/HeroField";
import { GitHubIcon, Mark } from "@/components/Mark";
import { Nav } from "@/components/Nav";
import { PackSwitcher, QualityReport } from "@/components/Quality";
import { Session } from "@/components/Session";
import { Statement } from "@/components/Statement";
import { FAQ, REPO_URL, SITE, SITE_URL, STATUS } from "@/lib/site";

const HEADLINE = ["Motion", "graphics", "that", "agents", "create", "and", "humans", "finish."];

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
        "Guideline packs with automatic quality checks",
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

function StatusList({
  items,
  kind,
}: {
  items: readonly (readonly [string, string])[];
  kind: string;
}) {
  return (
    <dl className="status-list" data-kind={kind}>
      {items.map(([name, body]) => (
        <div key={name}>
          <dt>{name}</dt>
          <dd>{body}</dd>
        </div>
      ))}
    </dl>
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

      <main id="main">
        <section className="hero" id="top">
          <HeroField />
          <div className="wrap hero-copy">
            <h1 className="display">
              {HEADLINE.map((word, i) => (
                <span key={word} className="word" style={{ "--i": i } as React.CSSProperties}>
                  {word}{" "}
                </span>
              ))}
            </h1>
            <p className="hero-sub">
              Connect Kynimo to your AI assistant. Describe the video. Get back layers and
              keyframes, not pixels.
            </p>
            <div className="hero-actions">
              <a className="btn btn-primary" href={REPO_URL} rel="noopener">
                <GitHubIcon />
                Follow on GitHub
              </a>
              <a className="link-down" href="#connect">
                See how it connects
                <Arrow />
              </a>
            </div>
            <p className="hero-status">In development. Built in the open.</p>
          </div>
          <div className="wrap hero-stage">
            <Session />
          </div>
        </section>

        <Statement />

        <section className="section" id="connect" aria-labelledby="connect-title">
          <div className="wrap">
            <header className="section-head">
              <h2 id="connect-title">One URL. Any assistant.</h2>
              <p className="lede">
                Kynimo is a remote MCP server. Add it once. Your assistant gets a motion studio's
                worth of tools, and you install nothing.
              </p>
            </header>
            <Connect />
          </div>
          <ToolTicker />
        </section>

        <section className="section" id="quality" aria-labelledby="quality-title">
          <div className="wrap">
            <header className="section-head">
              <h2 id="quality-title">Taste, written down.</h2>
              <p className="lede">
                A guideline pack is a motion design system your assistant has to follow: type,
                colour, springs, timing. Every render is then graded against it, and every finding
                names its fix.
              </p>
            </header>
            <QualityReport />

            <header className="section-head section-head-sub">
              <h3 className="h2-like">Same scene. Four temperaments.</h3>
              <p className="lede">
                Switch the pack and everything moves differently. The words stay the same.
              </p>
            </header>
            <PackSwitcher />
            <p className="fineprint center">
              Pack colours and springs are the real 0.1 drafts. The grading engine is next on the
              roadmap.
            </p>
          </div>
        </section>

        <section className="section" id="edit" aria-labelledby="edit-title">
          <div className="wrap">
            <header className="section-head">
              <h2 id="edit-title">Change a word. Keep the video.</h2>
              <p className="lede">
                Go on, type something. Each change is one small operation on the scene. Nothing is
                generated again.
              </p>
            </header>
            <Editable />
          </div>
        </section>

        <section className="section" id="status" aria-labelledby="status-title">
          <div className="wrap">
            <header className="section-head">
              <h2 id="status-title">Built in the open.</h2>
              <p className="lede">
                No launch countdown. Here is what runs today, and what comes next.
              </p>
            </header>
            <div className="status">
              <div>
                <h3>Runs today</h3>
                <StatusList items={STATUS.built} kind="built" />
              </div>
              <div>
                <h3>Next</h3>
                <StatusList items={STATUS.next} kind="next" />
              </div>
            </div>
          </div>
        </section>

        <section className="section" id="faq" aria-labelledby="faq-title">
          <div className="wrap faq">
            <h2 id="faq-title">Questions</h2>
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
          <div className="wrap">
            <h2 id="close-title" className="display">
              Watch it get built.
            </h2>
            <p className="lede">
              Every decision is written down. Every milestone lands in the repo.
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
