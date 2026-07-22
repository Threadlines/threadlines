import type { APIRoute } from "astro";
import { getCollection } from "astro:content";

import { changelogEntryPath } from "../lib/changelog";
import { absoluteSiteUrl } from "../lib/site";

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function urlEntry(path: string, lastModified?: Date): string {
  const lastModifiedElement = lastModified
    ? `<lastmod>${escapeXml(lastModified.toISOString())}</lastmod>`
    : "";
  return `<url><loc>${escapeXml(absoluteSiteUrl(path))}</loc>${lastModifiedElement}</url>`;
}

export const GET: APIRoute = async () => {
  const changelogEntries = await getCollection("changelog");
  const urls = [
    urlEntry("/"),
    urlEntry("/download/"),
    urlEntry("/changelog/"),
    ...changelogEntries.map((entry) => urlEntry(changelogEntryPath(entry), entry.data.date)),
  ];
  const body = `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.join("")}</urlset>`;

  return new Response(body, {
    headers: { "Content-Type": "application/xml; charset=utf-8" },
  });
};
