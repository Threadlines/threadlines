import { EnvironmentId } from "@threadlines/contracts";
import { describe, expect, it } from "vite-plus/test";

import { projectSearchEntriesQueryOptions } from "./projectReactQuery";

describe("projectSearchEntriesQueryOptions", () => {
  it("can load initial browse results for an empty query", () => {
    const options = projectSearchEntriesQueryOptions({
      environmentId: EnvironmentId.make("environment-1"),
      cwd: "/tmp/project",
      query: "",
      allowEmptyQuery: true,
    });

    expect(options.enabled).toBe(true);
  });

  it("keeps empty-query searches disabled unless browsing is requested", () => {
    const options = projectSearchEntriesQueryOptions({
      environmentId: EnvironmentId.make("environment-1"),
      cwd: "/tmp/project",
      query: "",
    });

    expect(options.enabled).toBe(false);
  });
});
