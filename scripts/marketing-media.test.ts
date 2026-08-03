import * as ChildProcess from "node:child_process";
import * as FileSystem from "node:fs";
import * as NodePath from "node:path";
import { fileURLToPath } from "node:url";

import { assert, describe, it } from "@effect/vitest";

import { resolveDefaultMarketingStudioRoot } from "./lib/marketing-studio-paths.ts";
import { assertCaptureWindowFullyVisible, parseCaptureManifest } from "./marketing-media.ts";

const repoRoot = NodePath.resolve(NodePath.dirname(fileURLToPath(import.meta.url)), "..");
const fixturePath = NodePath.join(
  repoRoot,
  "scripts/fixtures/marketing-studio/capture-scenes.json",
);
const marketingPublicRoot = NodePath.join(repoRoot, "apps/marketing/public");
const launchAssetRoot = NodePath.join(marketingPublicRoot, "Screenshots/launch");

describe("marketing media", () => {
  it("loads a coherent deterministic capture manifest", () => {
    const manifest = parseCaptureManifest(JSON.parse(FileSystem.readFileSync(fixturePath, "utf8")));

    assert.equal(manifest.release, "0.3.0");
    assert.deepEqual(manifest.geometry, {
      logicalWidth: 1600,
      logicalHeight: 934,
      deviceScaleFactor: 2,
      masterWidth: 3200,
      masterHeight: 1868,
      framesPerSecond: 60,
      colorSpace: "bt709",
    });
    assert.equal(manifest.scenes.filter((scene) => scene.kind === "motion").length, 6);
    assert.equal(
      manifest.scenes.find((scene) => scene.id === "platform-macos")?.windowMode,
      "native",
    );
    assert.equal(
      manifest.scenes.find((scene) => scene.id === "sidebar-attention-states-dark")?.cursorMode,
      "hidden",
    );
    assert.equal(
      manifest.scenes.find((scene) => scene.id === "agent-browser-workflow-light")?.cursorMode,
      "native",
    );
    assert.equal(
      manifest.scenes.find((scene) => scene.id === "agent-browser-workflow-dark")?.durationSeconds,
      20,
    );
    assert.match(
      manifest.scenes.find((scene) => scene.id === "agent-browser-workflow-dark")?.story ?? "",
      /Annotate.+attach.+composer.+live preview/i,
    );
    assert.equal(
      manifest.scenes.find((scene) => scene.id === "workspace-four-panel-overview-dark")
        ?.sourceControlOpen,
      true,
    );
    assert.equal(
      manifest.scenes.find((scene) => scene.id === "workspace-four-panel-overview-dark")
        ?.cursorMode,
      "native",
    );
    assert.equal(
      manifest.scenes.find((scene) => scene.id === "workspace-four-panel-overview-dark")
        ?.durationSeconds,
      20,
    );
    assert.equal(
      manifest.scenes
        .filter((scene) => scene.kind === "motion")
        .every((scene) =>
          manifest.scenes.some(
            (candidate) =>
              candidate.id ===
              scene.id.replace(/-(?:dark|light)$/, `-${scene.theme === "dark" ? "light" : "dark"}`),
          ),
        ),
      true,
    );
  });

  it("rejects manifests whose master and logical geometry disagree", () => {
    const raw = JSON.parse(FileSystem.readFileSync(fixturePath, "utf8")) as {
      geometry: { masterWidth: number };
    };
    raw.geometry.masterWidth = 3199;

    assert.throws(() => parseCaptureManifest(raw), /Master geometry/);
  });

  it("rejects a recording window that macOS would crop at a display edge", () => {
    assert.throws(
      () =>
        assertCaptureWindowFullyVisible({
          windowId: 42,
          bounds: { x: -44, y: 24, width: 1600, height: 934 },
          displays: [{ x: 0, y: 0, width: 1512, height: 982 }],
        }),
      /pad the off-screen edge black/,
    );
    assert.doesNotThrow(() =>
      assertCaptureWindowFullyVisible({
        windowId: 42,
        bounds: { x: 100, y: 100, width: 1600, height: 934 },
        displays: [{ x: 0, y: 0, width: 1800, height: 1169 }],
      }),
    );
  });

  it("uses neutral publish-safe default studio roots", () => {
    assert.equal(
      resolveDefaultMarketingStudioRoot({
        platform: "darwin",
        homeDirectory: "/Users/alice",
      }),
      "/Users/Shared/Threadlines Marketing Studio",
    );
    assert.equal(
      resolveDefaultMarketingStudioRoot({
        platform: "linux",
        homeDirectory: "/home/alice",
      }),
      "/tmp/Threadlines Marketing Studio",
    );
    assert.equal(
      resolveDefaultMarketingStudioRoot({
        platform: "win32",
        homeDirectory: String.raw`C:\Users\alice`,
      }),
      String.raw`C:\Users\Public\Documents\Threadlines Marketing Studio`,
    );
  });

  it("ships complete theme-matched marketing media pairs", () => {
    for (const base of [
      "workspace-four-panel-overview",
      "sidebar-attention-states",
      "agent-browser-workflow",
    ]) {
      for (const theme of ["dark", "light"]) {
        for (const suffix of [".mp4", ".webm", "-mobile.mp4", "-mobile.webm"]) {
          const assetPath = NodePath.join(launchAssetRoot, `${base}-${theme}${suffix}`);
          assert.equal(FileSystem.existsSync(assetPath), true, assetPath);
          assert.isAbove(FileSystem.statSync(assetPath).size, 10_000, assetPath);
        }
        const posterPath = NodePath.join(launchAssetRoot, "Posters", `${base}-${theme}.webp`);
        assert.equal(FileSystem.existsSync(posterPath), true, posterPath);
        assert.isAbove(FileSystem.statSync(posterPath).size, 10_000, posterPath);
      }
    }

    const socialImagePath = NodePath.join(marketingPublicRoot, "og.png");
    assert.equal(FileSystem.existsSync(socialImagePath), true);
    assert.isAbove(FileSystem.statSync(socialImagePath).size, 10_000);
    assert.equal(FileSystem.existsSync(NodePath.join(marketingPublicRoot, "og-v030.png")), false);
  });

  it("prints command help without touching the studio", () => {
    const result = ChildProcess.spawnSync(
      process.execPath,
      [NodePath.join(repoRoot, "scripts/marketing-media.ts"), "help"],
      {
        cwd: repoRoot,
        encoding: "utf8",
      },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /preflight --scene/);
    assert.match(result.stdout, /record\s+--scene/);
    assert.match(result.stdout, /allow-compressed-master/);
  });
});
