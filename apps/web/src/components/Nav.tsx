"use client";

import { useEffect, useState } from "react";
import { REPO_URL } from "@/lib/site";
import { GitHubIcon, Mark } from "./Mark";

const LINKS = [
  ["How it works", "#how"],
  ["Connect", "#connect"],
  ["Styles", "#styles"],
  ["Roadmap", "#roadmap"],
] as const;

export function Nav() {
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 12);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <header className="nav" data-scrolled={scrolled}>
      <div className="wrap nav-inner">
        <a className="lockup" href="#top" aria-label="Kynimo, back to top">
          <Mark className="lockup-mark" />
          <span>Kynimo</span>
        </a>
        <nav className="nav-links" aria-label="Sections">
          {LINKS.map(([label, href]) => (
            <a key={href} href={href}>
              {label}
            </a>
          ))}
        </nav>
        <a className="btn btn-quiet" href={REPO_URL} rel="noopener">
          <GitHubIcon />
          GitHub
        </a>
      </div>
    </header>
  );
}
