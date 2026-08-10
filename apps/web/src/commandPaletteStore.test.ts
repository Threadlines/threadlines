import { beforeEach, describe, expect, it } from "vite-plus/test";

import { useCommandPaletteStore } from "./commandPaletteStore";

function resetStore(): void {
  useCommandPaletteStore.setState({ open: false, openGeneration: 0, openIntent: null });
}

describe("command palette store", () => {
  beforeEach(resetStore);

  it("advances the open generation once per opening, not per open call", () => {
    const { setOpen, openAddProject } = useCommandPaletteStore.getState();

    setOpen(true);
    expect(useCommandPaletteStore.getState().openGeneration).toBe(1);

    // Re-purposing an already-open palette stays in the same session.
    setOpen(true);
    openAddProject();
    expect(useCommandPaletteStore.getState().openGeneration).toBe(1);

    setOpen(false);
    setOpen(true);
    expect(useCommandPaletteStore.getState().openGeneration).toBe(2);
  });

  it("closes via closeIfGeneration only for the current session", () => {
    const { setOpen, closeIfGeneration } = useCommandPaletteStore.getState();

    setOpen(true);
    const firstSession = useCommandPaletteStore.getState().openGeneration;
    setOpen(false);
    setOpen(true);

    // A continuation from the first session must not close the second.
    closeIfGeneration(firstSession);
    expect(useCommandPaletteStore.getState().open).toBe(true);

    closeIfGeneration(useCommandPaletteStore.getState().openGeneration);
    expect(useCommandPaletteStore.getState().open).toBe(false);

    // Already closed: a repeat stale close stays a no-op.
    closeIfGeneration(firstSession);
    expect(useCommandPaletteStore.getState().open).toBe(false);
  });

  it("clears the open intent when a guarded close lands", () => {
    const { openAddProject, closeIfGeneration } = useCommandPaletteStore.getState();

    openAddProject();
    expect(useCommandPaletteStore.getState().openIntent?.kind).toBe("add-project");

    closeIfGeneration(useCommandPaletteStore.getState().openGeneration);
    expect(useCommandPaletteStore.getState().openIntent).toBeNull();
  });
});
