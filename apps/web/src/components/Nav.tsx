"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { BETA_PATH, REPO_URL } from "@/lib/site";
import { GitHubIcon, Mark } from "./Mark";

const LINKS = [
  ["How it works", "#how"],
  ["Desktop app", "#desktop"],
  ["Features", "#features"],
  ["FAQ", "#faq"],
] as const;

/** `home` is false on sub-pages: section links go back to the home page and the beta button hides. */
export function Nav({ home = true }: { home?: boolean }) {
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
        <a
          className="lockup"
          href={home ? "#top" : "/"}
          aria-label={home ? "Kynimo, back to top" : "Kynimo, home"}
        >
          <Mark className="lockup-mark" />
          <span>Kynimo</span>
        </a>
        <nav className="nav-links" aria-label="Sections">
          {LINKS.map(([label, href]) => (
            <a key={href} href={home ? href : `/${href}`}>
              {label}
            </a>
          ))}
        </nav>
        <div className="nav-actions">
          <a className="nav-icon" href={REPO_URL} rel="noopener" aria-label="Kynimo on GitHub">
            <GitHubIcon />
          </a>
          {home && (
            <Link className="btn btn-primary btn-compact" href={BETA_PATH}>
              Try the beta
            </Link>
          )}
        </div>
      </div>
    </header>
  );
}
