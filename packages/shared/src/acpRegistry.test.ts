import { describe, expect, it } from "vite-plus/test";

import {
  acpRegistryAmbiguousAgentIds,
  acpRegistryInstallConfirmText,
  acpRegistryInstanceId,
  acpRegistryRowSubtitle,
  acpRegistrySourceText,
  filterAcpRegistryAgents,
} from "./acpRegistry.ts";

const goose = {
  agentId: "goose",
  name: "goose",
  authors: ["Block"],
  description: "A local, extensible, open source AI agent",
};
const gemini = {
  agentId: "gemini",
  name: "Gemini CLI",
  authors: ["Google"],
  description: "Google's official CLI for Gemini",
};

describe("community agent wording", () => {
  it("says who made the agent, that it is unreviewed, and where it runs", () => {
    expect(acpRegistryInstallConfirmText({ agent: goose, computer: "this Mac" })).toBe(
      "goose is made by Block. Threadlines hasn't reviewed it. It runs on this Mac and can read and change files in your projects.",
    );
    // From a phone, the computer is the one it is paired with.
    expect(
      acpRegistryInstallConfirmText({
        agent: { name: "Duo", authors: ["Ada", " Grace ", "Linus"] },
        computer: "Will's Mac mini",
      }),
    ).toBe(
      "Duo is made by Ada, Grace and Linus. Threadlines hasn't reviewed it. It runs on Will's Mac mini and can read and change files in your projects.",
    );
    // The registry sometimes writes an author with an address: the name is what is said.
    expect(
      acpRegistryInstallConfirmText({
        agent: { name: "Auggie", authors: ["Augment Code <support@augmentcode.com>"] },
        computer: "this Mac",
      }),
    ).toBe(
      "Auggie is made by Augment Code. Threadlines hasn't reviewed it. It runs on this Mac and can read and change files in your projects.",
    );
    expect(
      acpRegistryInstallConfirmText({
        agent: { name: "Fast", authors: ["enquiries@fast-agent.ai"] },
        computer: "this Mac",
      }),
    ).toContain("Fast is made by enquiries@fast-agent.ai.");
    expect(
      acpRegistryInstallConfirmText({ agent: { name: "Solo", authors: [] }, computer: "this PC" }),
    ).toBe(
      "Solo comes from the open ACP registry. Threadlines hasn't reviewed it. It runs on this PC and can read and change files in your projects.",
    );
  });

  it("says where the files come from and whether the download can be checked", () => {
    const from = (
      source: "npm" | "download",
      integrity: "checksum" | "none" | "package",
      rest: { packageSpec?: string; host?: string } = {},
    ) =>
      acpRegistrySourceText({
        source,
        integrity,
        packageSpec: rest.packageSpec ?? null,
        host: rest.host ?? null,
      });
    expect(from("npm", "package", { packageSpec: "@google/gemini-cli@0.62.0" })).toBe(
      "Installs @google/gemini-cli@0.62.0 from npm.",
    );
    expect(from("download", "checksum", { host: "github.com" })).toBe(
      "Downloads from github.com. The download is checked against the publisher's checksum.",
    );
    expect(from("download", "none", { host: "static.devin.ai" })).toBe(
      "Downloads from static.devin.ai. The publisher gives no checksum.",
    );
  });

  it("writes a row's second line from whatever the registry gives", () => {
    expect(acpRegistryRowSubtitle(goose)).toBe(
      "by Block · A local, extensible, open source AI agent",
    );
    expect(acpRegistryRowSubtitle({ authors: [], description: " Just this " })).toBe("Just this");
    expect(acpRegistryRowSubtitle({ authors: ["Ada"], description: "" })).toBe("by Ada");
  });
});

describe("community agent list", () => {
  it("searches name, id, author and description, every word", () => {
    const agents = [goose, gemini];
    expect(filterAcpRegistryAgents(agents, "")).toEqual(agents);
    expect(filterAcpRegistryAgents(agents, "GOOGLE")).toEqual([gemini]);
    expect(filterAcpRegistryAgents(agents, "open  agent")).toEqual([goose]);
    expect(filterAcpRegistryAgents(agents, "gemini block")).toEqual([]);
  });

  it("finds agents whose name alone doesn't tell them apart", () => {
    expect(
      acpRegistryAmbiguousAgentIds([
        goose,
        { agentId: "codebuddy", name: "Codebuddy" },
        { agentId: "codebuddy-code", name: "codebuddy " },
      ]),
    ).toEqual(new Set(["codebuddy", "codebuddy-code"]));
  });

  it("gives each agent one instance id", () => {
    expect(acpRegistryInstanceId("goose")).toBe("acp_goose");
  });
});
