import { assert, describe, it } from "@effect/vitest";

import { parsePlatformSuggestions } from "./ElectronSpelling.ts";

describe("ElectronSpelling", () => {
  describe("parsePlatformSuggestions", () => {
    it("parses a JSON array of suggestions", () => {
      assert.deepEqual(parsePlatformSuggestions('["America","American","americas"]\n'), [
        "America",
        "American",
        "americas",
      ]);
    });

    it("drops non-string entries, blanks, and duplicates", () => {
      assert.deepEqual(parsePlatformSuggestions('["I\'ve", 3, null, "  ", "I\'ve", " give "]'), [
        "I've",
        "give",
      ]);
    });

    it("caps the number of suggestions", () => {
      const output = JSON.stringify(Array.from({ length: 30 }, (_, index) => `word${index}`));
      assert.equal(parsePlatformSuggestions(output).length, 10);
    });

    it("returns no suggestions for non-array JSON", () => {
      assert.deepEqual(parsePlatformSuggestions('{"word":"America"}'), []);
      assert.deepEqual(parsePlatformSuggestions('"America"'), []);
    });

    it("returns no suggestions for malformed output", () => {
      assert.deepEqual(parsePlatformSuggestions(""), []);
      assert.deepEqual(parsePlatformSuggestions("execution error: ..."), []);
    });
  });
});
