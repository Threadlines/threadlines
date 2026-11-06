import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { extractJsonObject, fromLenientJson } from "./schemaJson.ts";

const decodeLenient = Schema.decodeUnknownSync(fromLenientJson(Schema.Unknown));

describe("schemaJson helpers", () => {
  it("extracts a balanced JSON object from surrounding text", () => {
    expect(
      extractJsonObject(`Sure, here is the JSON:
\`\`\`json
{
  "subject": "Update README",
  "body": ""
}
\`\`\`
Done.`),
    ).toBe(`{
  "subject": "Update README",
  "body": ""
}`);
  });

  it("ignores braces inside strings while finding the object boundary", () => {
    expect(
      extractJsonObject('prefix {"message":"literal } brace","nested":{"ok":true}} suffix'),
    ).toBe('{"message":"literal } brace","nested":{"ok":true}}');
  });

  it("returns trimmed input when no JSON object starts", () => {
    expect(extractJsonObject("  no structured output  ")).toBe("no structured output");
  });

  it("reads hand-edited JSON with comments and trailing commas", () => {
    expect(
      decodeLenient(`{
  // a note
  "list": [1, 2,],
  /* a block
     note */
  "nested": { "a": true, },
}`),
    ).toEqual({ list: [1, 2], nested: { a: true } });
  });

  it("leaves text inside quoted values exactly as written", () => {
    const values = {
      commaBracket: "keep ,] literally",
      commaBrace: "and ,} too",
      lineComment: "https://example.com // not a comment",
      blockComment: "a /* not a comment */ b",
      escapedQuote: 'say \\"hi\\", ]',
    };
    expect(decodeLenient(JSON.stringify(values, null, 2))).toEqual(values);
    expect(
      decodeLenient(`{"a": "x ,]", // "quote in a comment
  "b": "y /* z */",}`),
    ).toEqual({ a: "x ,]", b: "y /* z */" });
  });

  it("still refuses a block comment that never closes", () => {
    expect(() => decodeLenient('{"a": 1} /* never closed')).toThrow();
  });
});
