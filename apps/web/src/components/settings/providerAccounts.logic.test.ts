import { describe, expect, it } from "vite-plus/test";

import {
  accountFormCopy,
  addAccountMenuLabel,
  isThreadlinesAccountFolder,
  suggestAccountColor,
  suggestAccountName,
} from "./providerAccounts.logic";

describe("suggestAccountName", () => {
  it("offers Work, then Personal, then numbered names, never one in use", () => {
    expect(suggestAccountName([])).toBe("Work");
    expect(suggestAccountName(["work"])).toBe("Personal");
    expect(suggestAccountName(["Work", "Personal", "Account 2"])).toBe("Account 3");
  });
});

describe("suggestAccountColor", () => {
  it("skips colors the agent's other accounts already wear", () => {
    expect(suggestAccountColor([])).toBe("#16a34a");
    expect(suggestAccountColor(["#16A34A", undefined])).toBe("#ea580c");
  });
});

describe("accountFormCopy", () => {
  it("goes straight to sign-in only for agents that sign in to an account", () => {
    expect(accountFormCopy("claudeAgent", "Claude").startsSignIn).toBe(true);
    expect(accountFormCopy("antigravity", "Antigravity").submitLabel).toBe("Sign in with Google");
    expect(accountFormCopy("opencode", "OpenCode")).toMatchObject({
      submitLabel: "Add account",
      startsSignIn: false,
    });
  });
});

describe("addAccountMenuLabel", () => {
  it("uses the right article", () => {
    expect(addAccountMenuLabel("Claude")).toBe("Add a Claude account");
    expect(addAccountMenuLabel("OpenCode")).toBe("Add an OpenCode account");
  });
});

describe("isThreadlinesAccountFolder", () => {
  it("recognizes the folder Threadlines made for the account, on any platform", () => {
    expect(
      isThreadlinesAccountFolder({
        instanceId: "codex_work_3f9a",
        driver: "codex",
        config: { shadowHomePath: "/Users/me/.threadlines/userdata/accounts/codex_work_3f9a" },
      }),
    ).toBe(true);
    expect(
      isThreadlinesAccountFolder({
        instanceId: "claudeAgent_work_3f9a",
        driver: "claudeAgent",
        config: {
          accountFolder: "C:\\Users\\me\\.threadlines\\userdata\\accounts\\claudeAgent_work_3f9a",
        },
      }),
    ).toBe(true);
    expect(
      isThreadlinesAccountFolder({
        instanceId: "claudeAgent_work_3f9a",
        driver: "claudeAgent",
        config: { accountFolder: "~/claude-work" },
      }),
    ).toBe(false);
  });
});
