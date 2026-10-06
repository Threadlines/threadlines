import {
  ACP_REGISTRY_DRIVER_KIND,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@threadlines/contracts";
import { describe, expect, it } from "vite-plus/test";

import { providerIconMaskImage, resolveProviderGlyph } from "./providerIconUtils";

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
const ICON_SVG = `<svg xmlns="${SVG_NAMESPACE}" viewBox="0 0 16 16"><path d="M2 2h12v12H2z"/></svg>`;
const CODEX = ProviderDriverKind.make("codex");

function snapshot(input: {
  instanceId: string;
  driver: ProviderDriverKind;
  /** Set for a community agent; `null` is one the registry lists without an icon. */
  iconSvg?: string | null;
}): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(input.instanceId),
    driver: input.driver,
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-01-01T00:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    ...(input.iconSvg !== undefined
      ? {
          community: {
            agentId: "quill",
            authors: [],
            website: null,
            repository: null,
            iconSvg: input.iconSvg,
            source: "npm",
            packageSpec: null,
            host: null,
            verification: null,
            confirmedRecipeDigest: null,
            updateCandidate: null,
            reportedVersionChanged: false,
            signIn: { methods: [], selected: null, canSignOut: false },
          },
        }
      : {}),
  };
}

function communityAgent(iconSvg: string | null): ServerProvider {
  return snapshot({ instanceId: "acp_quill", driver: ACP_REGISTRY_DRIVER_KIND, iconSvg });
}

describe("providerIconMaskImage", () => {
  it("leaves no markup, quote or bracket of the icon unencoded", () => {
    const svg = `<svg xmlns="${SVG_NAMESPACE}" onload='alert(1)'><style>a{b:url(x)}</style>\n<script>"&#%</script></svg>`;

    const image = providerIconMaskImage(svg);

    const payload = image?.match(/^url\("data:image\/svg\+xml;charset=utf-8,(.*)"\)$/s)?.[1];
    expect(payload).toMatch(/^[A-Za-z0-9%._~!*-]+$/);
    expect(decodeURIComponent(payload ?? "")).toBe(svg);
  });

  it("refuses text it could not draw", () => {
    const opening = `<svg xmlns="${SVG_NAMESPACE}">`;
    const atLimit = `${opening}${" ".repeat(32 * 1024 - opening.length - "</svg>".length)}</svg>`;

    expect(providerIconMaskImage(atLimit)).not.toBeNull();
    expect(providerIconMaskImage(`${atLimit} `)).toBeNull();
    expect(providerIconMaskImage("")).toBeNull();
    expect(providerIconMaskImage("   ")).toBeNull();
    expect(providerIconMaskImage("<svg viewBox='0 0 16 16'></svg>")).toBeNull();
    expect(providerIconMaskImage(`<html xmlns="${SVG_NAMESPACE}"></html>`)).toBeNull();
    // A lone surrogate cannot be percent-encoded.
    expect(providerIconMaskImage(`${opening}\uD800</svg>`)).toBeNull();
  });
});

describe("resolveProviderGlyph", () => {
  it("draws a community agent with its own icon, whatever driver it runs on", () => {
    expect(
      resolveProviderGlyph({
        instanceId: ProviderInstanceId.make("acp_quill"),
        driver: ACP_REGISTRY_DRIVER_KIND,
        providers: [snapshot({ instanceId: "codex", driver: CODEX }), communityAgent(ICON_SVG)],
      }),
    ).toEqual({ kind: "svg", svg: ICON_SVG });
  });

  it("finds the icon on whichever computer's snapshot carries it", () => {
    expect(
      resolveProviderGlyph({
        instanceId: ProviderInstanceId.make("acp_quill"),
        providers: [communityAgent(null), communityAgent(ICON_SVG)],
      }),
    ).toEqual({ kind: "svg", svg: ICON_SVG });
  });

  it("draws a built-in provider with its driver's glyph", () => {
    const providers = [snapshot({ instanceId: "codex_personal", driver: CODEX })];
    const driverGlyph = { kind: "driver", driver: CODEX };

    // By instance alone (or with a label that names no driver), by driver
    // alone, and for an instance no snapshot knows.
    const instanceId = ProviderInstanceId.make("codex_personal");
    expect(resolveProviderGlyph({ instanceId, providers })).toEqual(driverGlyph);
    expect(resolveProviderGlyph({ instanceId, driver: "Codex", providers })).toEqual(driverGlyph);
    expect(resolveProviderGlyph({ driver: " codex ", providers: [] })).toEqual(driverGlyph);
    expect(
      resolveProviderGlyph({
        instanceId: ProviderInstanceId.make("codex_gone"),
        driver: CODEX,
        providers,
      }),
    ).toEqual(driverGlyph);
  });

  it("falls back to the generic glyph when there is no icon and no driver glyph", () => {
    const generic = { kind: "generic" };
    const instanceId = ProviderInstanceId.make("acp_quill");

    for (const iconSvg of [null, "", "x".repeat(32 * 1024 + 1)]) {
      expect(resolveProviderGlyph({ instanceId, providers: [communityAgent(iconSvg)] })).toEqual(
        generic,
      );
    }
    expect(resolveProviderGlyph({ driver: "retiredDriver", providers: [] })).toEqual(generic);
    // A label off the wire that happens to name something every object has.
    expect(resolveProviderGlyph({ driver: "constructor", providers: [] })).toEqual(generic);
    expect(resolveProviderGlyph({ providers: [] })).toEqual(generic);
  });
});
