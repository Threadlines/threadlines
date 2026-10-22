import { EnvironmentId } from "@threadlines/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  defaultProjectSetupFolder,
  isProtectedConnectionUrl,
  listProjectSetupTargets,
  projectSetupCloneOptions,
  type ProjectSetupComputer,
} from "./projectSetup.ts";

const MAC = EnvironmentId.make("environment-mac");
const LINUX = EnvironmentId.make("environment-linux");
const WINDOWS = EnvironmentId.make("environment-windows");

function computer(
  environmentId: EnvironmentId,
  label: string,
  overrides: Partial<ProjectSetupComputer> = {},
): ProjectSetupComputer {
  return {
    environmentId,
    label,
    connected: true,
    supportsProjectSetup: true,
    protectedConnection: true,
    projects: [],
    ...overrides,
  };
}

const WEB_APP = { repositoryKey: "github.com/acme/mono", subdirectory: "apps/web" };

describe("listProjectSetupTargets", () => {
  it("offers the connected computers that take setups and lack this folder of the repository", () => {
    const targets = listProjectSetupTargets({
      sourceEnvironmentId: MAC,
      project: WEB_APP,
      computers: [
        computer(MAC, "Mac", { projects: [WEB_APP] }),
        // The same repository, another folder in it: it doesn't have this project.
        computer(WINDOWS, "Windows PC", {
          projects: [{ repositoryKey: "github.com/acme/mono", subdirectory: "apps/api" }],
        }),
        // Has it already.
        computer(LINUX, "Linux box", {
          projects: [{ repositoryKey: "github.com/acme/mono", subdirectory: "apps/web" }],
        }),
      ],
    });
    expect(targets.map((target) => target.label)).toEqual(["Windows PC"]);
  });

  it("leaves out offline and older computers, and offers nothing for a project without a repository", () => {
    const computers = [
      computer(MAC, "Mac"),
      computer(WINDOWS, "Windows PC", { connected: false }),
      computer(LINUX, "Linux box", { supportsProjectSetup: false }),
    ];
    expect(
      listProjectSetupTargets({ sourceEnvironmentId: MAC, project: WEB_APP, computers }),
    ).toEqual([]);
    expect(
      listProjectSetupTargets({
        sourceEnvironmentId: MAC,
        project: null,
        computers: [computer(MAC, "Mac"), computer(WINDOWS, "Windows PC")],
      }),
    ).toEqual([]);
    // A source that can't describe its project has nothing to offer either.
    expect(
      listProjectSetupTargets({
        sourceEnvironmentId: MAC,
        project: WEB_APP,
        computers: [
          computer(MAC, "Mac", { supportsProjectSetup: false }),
          computer(WINDOWS, "Windows PC"),
        ],
      }),
    ).toEqual([]);
  });

  it("lets a project whose folder can't be told match on its repository alone", () => {
    const targets = listProjectSetupTargets({
      sourceEnvironmentId: MAC,
      project: WEB_APP,
      computers: [
        computer(MAC, "Mac"),
        computer(WINDOWS, "Windows PC", {
          projects: [{ repositoryKey: "github.com/acme/mono", subdirectory: null }],
        }),
      ],
    });
    expect(targets).toEqual([]);
  });

  it("names the computer reached without protection, on either end", () => {
    const unprotectedTarget = listProjectSetupTargets({
      sourceEnvironmentId: MAC,
      project: WEB_APP,
      computers: [
        computer(MAC, "Mac"),
        computer(WINDOWS, "Windows PC", { protectedConnection: false }),
        computer(LINUX, "Linux box"),
      ],
    });
    expect(unprotectedTarget).toEqual([
      { environmentId: LINUX, label: "Linux box", unprotected: null },
      {
        environmentId: WINDOWS,
        label: "Windows PC",
        unprotected: { environmentId: WINDOWS, label: "Windows PC" },
      },
    ]);
    const unprotectedSource = listProjectSetupTargets({
      sourceEnvironmentId: MAC,
      project: WEB_APP,
      computers: [computer(MAC, "Mac", { protectedConnection: false }), computer(LINUX, "Linux")],
    });
    expect(unprotectedSource[0]?.unprotected).toEqual({ environmentId: MAC, label: "Mac" });
  });
});

describe("isProtectedConnectionUrl", () => {
  it("protects TLS and loopback, not a plain address on the network", () => {
    expect(isProtectedConnectionUrl("wss://mac.tail1234.ts.net/ws")).toBe(true);
    expect(isProtectedConnectionUrl("https://mac.example.com")).toBe(true);
    expect(isProtectedConnectionUrl("ws://127.0.0.1:3773/ws")).toBe(true);
    expect(isProtectedConnectionUrl("ws://localhost:3773")).toBe(true);
    expect(isProtectedConnectionUrl("ws://[::1]:3773")).toBe(true);
    expect(isProtectedConnectionUrl("ws://192.168.1.20:3773/ws")).toBe(false);
    expect(isProtectedConnectionUrl("ws://test-pc.local:3773")).toBe(false);
    expect(isProtectedConnectionUrl("not a url")).toBe(false);
  });
});

describe("defaultProjectSetupFolder", () => {
  const source = { folderName: "badcode", homeRelativePath: "code/badcode" };

  it("uses the target's own copy of the repository before anything else", () => {
    expect(
      defaultProjectSetupFolder({
        ...source,
        existingCopyRoot: "/home/will/src/mono",
        baseDirectory: "~/work",
        projectRoots: ["/home/will/src/mono", "/home/will/src/other"],
      }),
    ).toBe("/home/will/src/mono");
  });

  it("then the target's own base folder", () => {
    expect(
      defaultProjectSetupFolder({
        ...source,
        baseDirectory: "C:\\dev",
        projectRoots: ["/home/will/src/other"],
      }),
    ).toBe("C:\\dev\\badcode");
    expect(
      defaultProjectSetupFolder({ ...source, baseDirectory: "~/work/", projectRoots: [] }),
    ).toBe("~/work/badcode");
  });

  it("then the folder most of the target's projects share", () => {
    expect(
      defaultProjectSetupFolder({
        ...source,
        baseDirectory: "",
        projectRoots: ["/home/will/src/one", "/home/will/src/two", "/opt/three"],
      }),
    ).toBe("/home/will/src/badcode");
    expect(
      defaultProjectSetupFolder({
        ...source,
        baseDirectory: null,
        projectRoots: ["D:\\code\\one", "D:\\code\\two"],
      }),
    ).toBe("D:\\code\\badcode");
  });

  it("then the source's place under home, then home itself", () => {
    // A project at a filesystem root says nothing about where projects go.
    expect(
      defaultProjectSetupFolder({ ...source, baseDirectory: "", projectRoots: ["/badcode"] }),
    ).toBe("~/code/badcode");
    expect(
      defaultProjectSetupFolder({
        folderName: "badcode",
        homeRelativePath: null,
        baseDirectory: "",
        projectRoots: [],
      }),
    ).toBe("~/badcode");
  });
});

describe("projectSetupCloneOptions", () => {
  it("offers both protocols only when the URL converts", () => {
    expect(
      projectSetupCloneOptions({
        name: "origin",
        url: "git@github.com:acme/mono.git",
        protocol: "ssh",
      }),
    ).toEqual([
      { protocol: "ssh", url: "git@github.com:acme/mono.git" },
      { protocol: "https", url: "https://github.com/acme/mono.git" },
    ]);
    expect(
      projectSetupCloneOptions({
        name: "origin",
        url: "https://git.example.com:8443/acme/mono.git",
        protocol: "https",
      }),
    ).toEqual([{ protocol: "https", url: "https://git.example.com:8443/acme/mono.git" }]);
  });
});
