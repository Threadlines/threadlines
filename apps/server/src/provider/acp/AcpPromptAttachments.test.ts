// @effect-diagnostics nodeBuiltinImport:off
import * as os from "node:os";
import * as path from "node:path";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";

import type { ChatAttachment } from "@threadlines/contracts";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { describe, expect } from "vite-plus/test";

import { antigravityAttachmentDelivery } from "../antigravity/AntigravityAttachments.ts";
import { acpAttachmentContent } from "./AcpPromptAttachments.ts";

const image = (sizeBytes: number): ChatAttachment => ({
  type: "image",
  id: "img-1",
  name: "shot.png",
  mimeType: "image/png",
  sizeBytes,
});

const withDir = <A, E>(use: (dir: string) => Effect.Effect<A, E>) =>
  Effect.acquireUseRelease(
    Effect.promise(() => mkdtemp(path.join(os.tmpdir(), "acp-attachments-"))),
    use,
    (dir) => Effect.promise(() => rm(dir, { recursive: true, force: true })),
  );

describe("acpAttachmentContent", () => {
  it.live("refuses a staged file replaced by a link", () =>
    withDir((dir) =>
      Effect.gen(function* () {
        const target = path.join(dir, "secret.png");
        const staged = path.join(dir, "img-1.png");
        yield* Effect.promise(async () => {
          await writeFile(target, "secret");
          await symlink(target, staged);
        });
        const error = yield* Effect.flip(
          acpAttachmentContent({
            attachment: image(6),
            path: staged,
            delivery: "inline",
            budget: { inlineBytes: 0 },
          }),
        );
        expect(error._tag).toBe("AcpAttachmentReadError");
        // A PDF link to it is refused too.
        const linked = yield* Effect.flip(
          acpAttachmentContent({
            attachment: { ...image(6), type: "file", kind: "pdf", mimeType: "application/pdf" },
            path: staged,
            delivery: "link",
            budget: { inlineBytes: 0 },
          }),
        );
        expect(linked._tag).toBe("AcpAttachmentReadError");
      }),
    ),
  );

  it.live("goes by the bytes it reads, not the size the record claims", () =>
    withDir((dir) =>
      Effect.gen(function* () {
        const staged = path.join(dir, "img-1.png");
        // The record says 4 bytes; the file has grown past an image's limit.
        yield* Effect.promise(() => writeFile(staged, Buffer.alloc(10 * 1024 * 1024 + 1)));
        const grown = yield* acpAttachmentContent({
          attachment: image(4),
          path: staged,
          delivery: "inline",
          budget: { inlineBytes: 0 },
        });
        expect(grown.map((block) => block.type)).toEqual(["text"]);

        // The message's allowance is charged with the real bytes.
        yield* Effect.promise(() => writeFile(staged, Buffer.alloc(3_000)));
        const budget = { inlineBytes: 50 * 1024 * 1024 - 2_000 };
        const over = yield* acpAttachmentContent({
          attachment: image(4),
          path: staged,
          delivery: "inline",
          budget,
        });
        expect(over.map((block) => block.type)).toEqual(["text"]);
        const roomy = { inlineBytes: 0 };
        const sent = yield* acpAttachmentContent({
          attachment: image(4),
          path: staged,
          delivery: "inline",
          budget: roomy,
        });
        expect(sent.map((block) => block.type)).toEqual(["image"]);
        expect(roomy.inlineBytes).toBe(3_000);
      }),
    ),
  );
});

describe("antigravityAttachmentDelivery", () => {
  it("links a PDF even when the agent takes no embedded text", () => {
    const pdf: ChatAttachment = {
      type: "file",
      kind: "pdf",
      id: "pdf-1",
      name: "spec.pdf",
      mimeType: "application/pdf",
      sizeBytes: 9,
    };
    const text: ChatAttachment = { ...pdf, kind: "text", mimeType: "text/plain" };
    expect(antigravityAttachmentDelivery(pdf, {})).toBe("link");
    expect(antigravityAttachmentDelivery(pdf, { embeddedContext: false })).toBe("link");
    // Embedded text still needs the capability.
    expect(antigravityAttachmentDelivery(text, { embeddedContext: false })).toBe("note");
  });
});
