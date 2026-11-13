/**
 * What was typed in the browser panel's address bar: an address to load, or
 * words to search for. Apart from `previewUrl.ts`, which the app needs at
 * startup to open links; only the panel itself reads the address bar.
 */
import { normalizePreviewUrl } from "./previewUrl";

/** What an address bar entry asks for: a page to load, or words to search for. */
export type AddressEntry =
  | { readonly kind: "url"; readonly url: string }
  | { readonly kind: "search"; readonly query: string };

/**
 * Reads what was typed in the address bar the way a browser does: an address
 * loads, anything else is a search. Null when there is nothing to do.
 *
 * Only the part before any path decides. With a path or a port it is an
 * address, spaces after it and all (`localhost:5173/a b`, `intranet/`). A bare
 * name is an address when it is `localhost`, has a dot, or is a full IP
 * address; a lone word, a number like 3.14 and an email address are searches.
 * A leading `?` forces a search. An entry with a scheme we do not load
 * (`file:`) does nothing, as before, rather than searching for it.
 */
export function resolveAddressEntry(input: string): AddressEntry | null {
  const typed = input.trim();
  if (typed === "") return null;
  if (typed.startsWith("?")) {
    const query = typed.slice(1).trim();
    return query === "" ? null : { kind: "search", query };
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(typed)) {
    const url = normalizePreviewUrl(typed);
    return url === null ? null : { kind: "url", url };
  }

  const search: AddressEntry = { kind: "search", query: typed };
  // As the address is read below: leading slashes are dropped, and a
  // backslash separates a path like a slash does.
  const bare = typed.replace(/^\/+/, "");
  const authority = bare.split(/[/\\?#]/, 1)[0] ?? "";
  if (authority === "" || /\s/.test(authority)) return search;
  const url = normalizePreviewUrl(typed);
  if (url === null) return search;
  const address: AddressEntry = { kind: "url", url };
  const hasPath = /[/\\]/.test(bare.split(/[?#]/, 1)[0] ?? "");
  if (hasPath || /:\d+$/.test(authority)) return address;

  // A bare name from here on.
  if (authority.includes("@")) return search;
  if (/^[\d.]+$/.test(authority)) {
    // 3.14 parses as an IP address; only four numbers are meant as one.
    return /^\d{1,3}(\.\d{1,3}){3}\.?$/.test(authority) ? address : search;
  }
  // The parsed host, so a name written with other scripts' dots still counts.
  const host = new URL(url).hostname;
  return host === "localhost" || host.includes(".") || host.startsWith("[") ? address : search;
}
