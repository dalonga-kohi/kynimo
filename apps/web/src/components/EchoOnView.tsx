"use client";

import { useEffect } from "react";

/**
 * Plays the hero's motion-study echo on every `[data-echo]` heading the first time it is
 * mostly on screen. The heading is fully visible without it; the echo only adds the trail.
 */
export function EchoOnView() {
  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          entry.target.setAttribute("data-echoed", "");
          observer.unobserve(entry.target);
        }
      },
      { threshold: 0.6 },
    );
    for (const el of document.querySelectorAll("[data-echo]")) observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return null;
}
