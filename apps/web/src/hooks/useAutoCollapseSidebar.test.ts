import { describe, expect, it } from "vitest";

import { resolveAutoCollapse } from "./useAutoCollapseSidebar";

/**
 * The whole feature is the restraint. Collapsing is one line; not doing it
 * again after the user has said otherwise is what makes it tolerable.
 */
describe("resolveAutoCollapse", () => {
  const base = { squeezed: true, expanded: true, collapsedByUs: false, overruled: false };

  it("folds the sidebar when both panels squeeze the chat", () => {
    expect(resolveAutoCollapse(base)).toEqual({ collapse: true, overrule: false });
  });

  it("leaves an already-collapsed sidebar alone", () => {
    expect(resolveAutoCollapse({ ...base, expanded: false })).toEqual({
      collapse: false,
      overrule: false,
    });
  });

  it("does nothing when only one panel is open", () => {
    expect(resolveAutoCollapse({ ...base, squeezed: false })).toEqual({
      collapse: false,
      overrule: false,
    });
  });

  it("treats expanding it back as being told to stop", () => {
    // The user reached for the control while still squeezed. That is a
    // decision, and it outranks ours.
    expect(resolveAutoCollapse({ ...base, collapsedByUs: true })).toEqual({
      collapse: false,
      overrule: true,
    });
  });

  it("never collapses again once overruled", () => {
    // The second unrequested collapse is the one that makes people stop
    // trusting the sidebar.
    expect(resolveAutoCollapse({ ...base, overruled: true })).toEqual({
      collapse: false,
      overrule: false,
    });
    expect(resolveAutoCollapse({ ...base, overruled: true, collapsedByUs: true })).toEqual({
      collapse: false,
      overrule: false,
    });
  });
});
