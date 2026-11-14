import type { MetadataRoute } from "next";
import { BETA_PATH, SITE_URL } from "@/lib/site";

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    { url: `${SITE_URL}/`, changeFrequency: "weekly", priority: 1 },
    { url: `${SITE_URL}${BETA_PATH}`, changeFrequency: "weekly", priority: 0.9 },
    { url: `${SITE_URL}/llms.txt`, changeFrequency: "weekly", priority: 0.5 },
    { url: `${SITE_URL}/llms-full.txt`, changeFrequency: "weekly", priority: 0.5 },
  ];
}
