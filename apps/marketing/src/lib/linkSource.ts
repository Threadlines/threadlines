/**
 * Where a link to the site was shared, read from the link itself.
 *
 * Links we share carry `?ref=<place>` (`x`, `readme`, ...). Vercel only shows `utm_*`
 * tags with its paid Web Analytics Plus add-on, so the layout reports the tag as the
 * "Arrived from link" custom event instead, which the Pro plan includes. `utm_source`
 * counts too, for links other people tag.
 */
const SOURCE_PARAMS = ["ref", "utm_source"] as const;
const MAX_SOURCE_LENGTH = 64;

/** The link's source tag, lowercased, or null when the link carried none. */
export function linkSource(url: URL): string | null {
  for (const param of SOURCE_PARAMS) {
    const value = url.searchParams.get(param)?.trim().toLowerCase();
    if (value) return value.slice(0, MAX_SOURCE_LENGTH);
  }
  return null;
}

/** The same address without source tags, so a copied link doesn't pass ours along. */
export function withoutLinkSource(url: URL): URL {
  const clean = new URL(url);
  const kept = Array.from(url.searchParams).filter(
    ([key]) => key !== "ref" && !key.startsWith("utm_"),
  );
  clean.search = new URLSearchParams(kept).toString();
  return clean;
}
