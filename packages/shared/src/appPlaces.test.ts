import { DEFAULT_SERVER_SETTINGS } from "@threadlines/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  APP_PLACES,
  placeIdFromHref,
  placeMarkdownLink,
  placePathLabel,
  placeRoute,
} from "./appPlaces.ts";

describe("app places", () => {
  it("is one tree: unique ids, parents that exist, rows in sections, sections on pages with routes", () => {
    const byId = new Map(APP_PLACES.map((place) => [place.id, place]));
    expect(byId.size).toBe(APP_PLACES.length);
    for (const place of APP_PLACES) {
      const parent = "parent" in place ? byId.get(place.parent) : undefined;
      if (place.kind === "page") {
        expect(place.route.to.startsWith("/"), place.id).toBe(true);
      } else if (place.kind === "section") {
        expect(parent?.kind, place.id).toBe("page");
      } else {
        expect(parent?.kind, place.id).toBe("section");
      }
    }
  });

  it("words every choice it reports with a label, from the default settings", () => {
    for (const place of APP_PLACES) {
      if (!("value" in place) || place.value.kind !== "choice") continue;
      const current = place.value.read(DEFAULT_SERVER_SETTINGS);
      expect(place.value.options, place.id).toHaveProperty(current);
    }
  });

  it("names a place as the screen does and links it", () => {
    expect(placePathLabel("threads.agentThreads")).toBe(
      "Settings › Threads › New threads › Agents can start threads",
    );
    expect(placePathLabel("fleet.worksWith")).toBe("Fleet › Works with other computers");
    expect(placeRoute("connections.threadlinesCommand")).toEqual({
      to: "/settings/connections",
      search: { section: "agents" },
    });
    expect(placeMarkdownLink("threads.enableRooms")).toBe(
      "[Settings › Threads › Rooms › Rooms](threadlines-place:threads.enableRooms)",
    );
    expect(placeIdFromHref("threadlines-place:threads.enableRooms")).toBe("threads.enableRooms");
    expect(placeIdFromHref("threadlines-place:nowhere.atAll")).toBeNull();
    expect(placeIdFromHref("https://example.com")).toBeNull();
  });
});
