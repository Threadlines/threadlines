import { describe, expect, it } from "vite-plus/test";

import { describePickedElementForComposer } from "./pickedElementContext";

const base = {
  tagName: "button",
  role: "button",
  name: "Sign in",
  selector: "#cta",
  text: "Sign in",
  rect: { x: 10, y: 20, width: 220, height: 60 },
  url: "http://localhost:5173/",
};

describe("describePickedElementForComposer", () => {
  it("leads with role and name, which is how the element is found again", () => {
    expect(describePickedElementForComposer(base)).toBe(
      '[selected element] button "Sign in" · selector: #cta · 220×60 at http://localhost:5173/',
    );
  });

  it("omits text that only repeats the name", () => {
    expect(describePickedElementForComposer(base)).not.toContain("text:");
  });

  it("includes text when it says something the name does not", () => {
    const described = describePickedElementForComposer({
      ...base,
      name: "Submit",
      text: "Submit your application",
    });

    expect(described).toContain('text: "Submit your application"');
  });

  it("falls back to the tag when the element has no accessible name", () => {
    const described = describePickedElementForComposer({
      ...base,
      role: null,
      name: null,
      text: null,
    });

    expect(described).toContain("<button>");
  });
});
