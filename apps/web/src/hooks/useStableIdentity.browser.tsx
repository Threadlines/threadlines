import { describe, expect, it } from "vite-plus/test";
import { render } from "vitest-browser-react";
import { shallow } from "zustand/vanilla/shallow";

import { useKept, useStableHandlers } from "./useStableIdentity";

interface Actions {
  readonly open: (id: string) => string;
  readonly close: (() => void) | null;
  readonly save: (() => void) | undefined;
  readonly label: string;
}

describe("useStableHandlers", () => {
  it("keeps its stand-ins while only the handlers are rebuilt, and calls the newest", async () => {
    const seen: Array<Actions | null> = [];
    function Probe({ actions }: { actions: Actions | null }) {
      seen.push(useStableHandlers(actions));
      return null;
    }
    const actions = (open: Actions["open"], label = "Plan"): Actions => ({
      open,
      close: null,
      save: undefined,
      label,
    });

    const screen = await render(<Probe actions={actions((id) => `first ${id}`)} />);
    const first = seen.at(-1)!;
    // A name without a handler stays as it was passed.
    expect(first.close).toBeNull();
    expect(first.save).toBeUndefined();

    await screen.rerender(<Probe actions={actions((id) => `second ${id}`)} />);
    expect(seen.at(-1)).toBe(first);
    expect(first.open("a")).toBe("second a");

    // Anything else in it changing gives new stand-ins, which also call the newest.
    await screen.rerender(<Probe actions={actions((id) => `third ${id}`, "Other")} />);
    const relabeled = seen.at(-1)!;
    expect(relabeled).not.toBe(first);
    expect(relabeled.label).toBe("Other");
    expect(relabeled.open("b")).toBe("third b");
    expect(first.open("c")).toBe("third c");

    await screen.rerender(<Probe actions={null} />);
    expect(seen.at(-1)).toBeNull();
    await screen.unmount();
  });
});

describe("useKept", () => {
  it("keeps the earlier value while a rebuilt one holds the same things", async () => {
    const seen: Array<ReadonlySet<string>> = [];
    function Probe({ ids }: { ids: ReadonlySet<string> }) {
      seen.push(useKept(ids, shallow));
      return null;
    }

    const screen = await render(<Probe ids={new Set(["a", "b"])} />);
    const first = seen.at(-1)!;
    await screen.rerender(<Probe ids={new Set(["a", "b"])} />);
    expect(seen.at(-1)).toBe(first);

    const changed = new Set(["a", "c"]);
    await screen.rerender(<Probe ids={changed} />);
    expect(seen.at(-1)).toBe(changed);
    await screen.unmount();
  });
});
