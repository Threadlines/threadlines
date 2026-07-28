import { describe, expect, it } from "vitest";

import { completeUrl, rememberVisit, type VisitedUrl } from "./urlCompletion";

const visited = (url: string, visits: number, lastVisitedAt: number): VisitedUrl => ({
  url,
  visits,
  lastVisitedAt,
});

describe("completeUrl", () => {
  const history = [
    visited("https://facpmanuals.com/", 12, 500),
    visited("https://fastmail.com/", 2, 900),
    visited("http://localhost:18821/", 3, 100),
  ];

  it("finishes a site from the few letters people actually type", () => {
    expect(completeUrl("facp", history)).toBe("facpmanuals.com/");
  });

  it("ignores the scheme and www, which nobody types", () => {
    expect(completeUrl("localhost:1", history)).toBe("localhost:18821/");
    expect(completeUrl("www.facp", [visited("https://www.facpmanuals.com/", 4, 10)])).toBe(
      "www.facpmanuals.com/",
    );
  });

  it("extends what was typed instead of rewriting it", () => {
    // The caller selects everything past the typed text, so the guess must
    // keep it as a literal prefix. Offering the stored `http://...` form here
    // once turned continued typing of "google" into "httple".
    expect(completeUrl("goog", [visited("http://google.com/", 1, 1)])).toBe("google.com/");
    expect(completeUrl("http://goog", [visited("http://google.com/", 1, 1)])).toBe(
      "http://google.com/",
    );
  });

  it("prefers the site you go to often over the one you saw recently", () => {
    // fastmail was visited more recently; facpmanuals is where this person
    // actually lives, and "fa" should not become a coin toss.
    expect(completeUrl("fa", history)).toBe("facpmanuals.com/");
  });

  it("stays quiet until there is enough to go on", () => {
    // A guess that changes on every keystroke reads as the field being
    // possessed rather than helpful.
    expect(completeUrl("f", history)).toBeNull();
  });

  it("offers nothing when nothing matches", () => {
    expect(completeUrl("example", history)).toBeNull();
  });
});

describe("rememberVisit", () => {
  it("counts repeat visits rather than listing them twice", () => {
    const once = rememberVisit([], "https://a.com/", 1);
    const twice = rememberVisit(once, "https://a.com/", 2);

    expect(twice).toHaveLength(1);
    expect(twice[0]).toEqual({ url: "https://a.com/", visits: 2, lastVisitedAt: 2 });
  });

  it("keeps a well-worn site over a one-off when the list is full", () => {
    // Dropping by age would lose the site you use daily after one busy morning
    // somewhere else.
    const daily = visited("https://daily.com/", 40, 1);
    const list = Array.from({ length: 199 }, (_, index) =>
      visited(`https://one-off-${index}.com/`, 1, 100 + index),
    );

    const full = rememberVisit([daily, ...list], "https://new.com/", 999);

    expect(full).toHaveLength(200);
    expect(full.some((entry) => entry.url === "https://daily.com/")).toBe(true);
  });

  it("does not record a blank tab as a place you have been", () => {
    expect(rememberVisit([], "", 1)).toEqual([]);
    expect(rememberVisit([], "   ", 1)).toEqual([]);
  });
});
