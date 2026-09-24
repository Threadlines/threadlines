import { serialize } from "node:v8";
import { describe, expect, it } from "vite-plus/test";

import { toOneByteString } from "./oneByteString";

/** How `postMessage` carries a string: V8's serializer tags one-byte `"`, two-byte `c`. */
function storedWidth(text: string): "one-byte" | "two-byte" | "unknown" {
  const bytes = serialize(text);
  let index = 2; // Past the version header.
  while (bytes[index] === 0) index += 1; // Alignment padding before two-byte payloads.
  if (bytes[index] === 0x22) return "one-byte";
  if (bytes[index] === 0x63) return "two-byte";
  return "unknown";
}

describe("toOneByteString", () => {
  it("stores plain code cut from a reply with an em dash one byte per character", () => {
    const reply = `Here’s the fix — see below.\n${"const answer = compute(42);\n".repeat(20)}`;
    const code = reply.slice(reply.indexOf("\n") + 1);
    expect(storedWidth(code)).toBe("two-byte");

    const copy = toOneByteString(code);
    expect(copy).toBe(code);
    expect(storedWidth(copy)).toBe("one-byte");
  });

  it("returns text that needs two bytes unchanged, lone surrogates included", () => {
    for (const text of ["a — b", "chunk ends mid emoji \ud83d", "\ude00 chunk starts mid emoji"]) {
      expect(toOneByteString(text)).toBe(text);
    }
  });
});
