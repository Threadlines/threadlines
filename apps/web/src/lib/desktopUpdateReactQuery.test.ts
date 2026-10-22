import { describe, expect, it } from "vite-plus/test";
import { desktopUpdateStateQueryOptions } from "./desktopUpdateReactQuery";

describe("desktopUpdateStateQueryOptions", () => {
  it("always refetches on mount so Settings does not reuse stale desktop update state", () => {
    const options = desktopUpdateStateQueryOptions();

    expect(options.staleTime).toBe(Infinity);
    expect(options.refetchOnMount).toBe("always");
  });
});
