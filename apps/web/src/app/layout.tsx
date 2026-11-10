import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "@fontsource-variable/mona-sans/wdth.css";
import "@fontsource-variable/geist-mono";
import "./globals.css";
import { SITE, SITE_URL } from "@/lib/site";

const title = "Kynimo: motion graphics your AI assistant builds and you can still edit";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: { default: title, template: "%s · Kynimo" },
  description: SITE.description,
  applicationName: SITE.name,
  keywords: [
    "motion graphics",
    "MCP server",
    "Model Context Protocol",
    "AI video",
    "AI motion design",
    "editable video",
    "product launch video",
    "motion design guidelines",
    "After Effects alternative",
  ],
  alternates: {
    canonical: "/",
    types: { "text/plain": [{ url: "/llms.txt", title: "Kynimo for language models" }] },
  },
  openGraph: {
    type: "website",
    url: "/",
    siteName: SITE.name,
    title,
    description: SITE.description,
    locale: "en_US",
  },
  twitter: { card: "summary_large_image", title, description: SITE.description },
  robots: {
    index: true,
    follow: true,
    googleBot: { index: true, follow: true, "max-image-preview": "large", "max-snippet": -1 },
  },
};

export const viewport: Viewport = {
  themeColor: "#0c0b0a",
  colorScheme: "dark",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
