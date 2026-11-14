import Link from "next/link";
import { BETA_PATH, REPO_URL } from "@/lib/site";
import { Mark } from "./Mark";

export function Footer({ home = true }: { home?: boolean }) {
  return (
    <footer className="footer">
      <div className="wrap footer-inner">
        <a
          className="lockup"
          href={home ? "#top" : "/"}
          aria-label={home ? "Kynimo, back to top" : "Kynimo, home"}
        >
          <Mark className="lockup-mark" />
          <span>Kynimo</span>
        </a>
        <p>Every scene on this page is illustrative and drawn live in your browser.</p>
        <nav aria-label="Footer">
          <Link href={BETA_PATH}>Beta</Link>
          <a href={REPO_URL} rel="noopener">
            GitHub
          </a>
          <a href="/llms.txt">llms.txt</a>
          <span>© 2026 Kynimo</span>
        </nav>
      </div>
    </footer>
  );
}
