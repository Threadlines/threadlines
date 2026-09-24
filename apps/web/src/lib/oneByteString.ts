/**
 * An equal copy of `text` that V8 stores at one byte per character whenever
 * every character fits in one.
 *
 * Once any character of a string needs two bytes, V8 stores the whole string
 * two bytes per character, and slices of it inherit that. A code block cut
 * from a reply with one em dash or curly quote in its prose is therefore
 * two-byte even when the code is plain ASCII, and it stays that way through
 * `postMessage`. Shiki's JavaScript regex engine tokenizes two-byte strings
 * 2-3x slower, measured on 4-20 KB TSX blocks.
 *
 * `JSON.parse` builds each string from its characters and picks one byte per
 * character when they all fit. Unlike a TextEncoder round trip it keeps lone
 * surrogates, which a streamed chunk can end on. Text that really needs two
 * bytes comes back equal, just not smaller.
 */
export function toOneByteString(text: string): string {
  return JSON.parse(JSON.stringify(text)) as string;
}
