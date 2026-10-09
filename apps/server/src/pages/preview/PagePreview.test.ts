// @effect-diagnostics nodeBuiltinImport:off - plain local servers stand in for LAN services.
import * as NodeDgram from "node:dgram";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import { makePagePreview } from "./PagePreview.ts";
import { makePreviewBrowser, type PreviewBrowser } from "./PreviewBrowser.ts";

/** A browser installer that hands out `executable` as already installed. */
const installedAt = (executable: string): PreviewBrowser => ({
  acquire: Effect.succeed(executable),
  acquireInstalled: Effect.succeedSome(executable),
});

/** A stand-in browser: a Node script that reads CDP commands off fd 3 and answers on fd 4. */
const standInBrowser = (script: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "threadlines-stand-in-browser-",
    });
    const executable = path.join(directory, "chrome-headless-shell");
    yield* fileSystem.writeFileString(executable, `#!${process.execPath}\n${script}`);
    yield* fileSystem.chmod(executable, 0o755);
    return executable;
  });

/** Exits once the first command arrives. */
const EXITS = `new (process.getBuiltinModule("node:net").Socket)({ fd: 3 }).on("data", (chunk) => { if (chunk.includes(0)) process.exit(1); });`;

/** Answers every command until the page navigates, then never answers again. */
const STALLS_AFTER_SETUP = `
const fs = process.getBuiltinModule("node:fs");
let buffered = "";
let stalled = false;
new (process.getBuiltinModule("node:net").Socket)({ fd: 3 }).on("data", (chunk) => {
  buffered += chunk;
  for (let end = buffered.indexOf("\\0"); end !== -1; end = buffered.indexOf("\\0")) {
    const command = JSON.parse(buffered.slice(0, end));
    buffered = buffered.slice(end + 1);
    if (command.method === "Page.navigate") stalled = true;
    if (!stalled) fs.writeSync(4, JSON.stringify({ id: command.id, result: { targetId: "page", sessionId: "page-session" } }) + "\\0");
  }
});`;

describe.skipIf(process.platform === "win32")("PagePreview.measure", () => {
  it.live("never fails: a browser that exits leaves the page unmeasured", () =>
    Effect.gen(function* () {
      const executable = yield* standInBrowser(EXITS);
      const pagePreview = yield* makePagePreview(installedAt(executable));

      expect(yield* pagePreview.measure({ document: "<p>x</p>", widths: [400, 800] })).toEqual(
        Option.none(),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("gives up at its cap when the browser stops answering mid-page", () =>
    Effect.gen(function* () {
      const executable = yield* standInBrowser(STALLS_AFTER_SETUP);
      const pagePreview = yield* makePagePreview(installedAt(executable), {
        measureTimeout: "300 millis",
      });

      const started = Date.now();
      expect(yield* pagePreview.measure({ document: "<p>x</p>", widths: [400] })).toEqual(
        Option.none(),
      );
      expect(Date.now() - started).toBeLessThan(5_000);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});

// Real-browser tests install the pinned Chrome for Testing (about 100 MB) into
// THREADLINES_TEST_PREVIEW_BROWSER_CACHES, or a folder in the system temp
// folder, and reuse it on later runs. They run only when this is "1".
const REAL_BROWSER = process.env.THREADLINES_TEST_PREVIEW_BROWSER === "1";
const realCachesDir =
  process.env.THREADLINES_TEST_PREVIEW_BROWSER_CACHES ??
  `${NodeOS.tmpdir()}/threadlines-preview-browser-test`;
// The first run downloads the browser.
const REAL_BROWSER_TIMEOUT = 10 * 60_000;

const realPagePreview = Effect.gen(function* () {
  const browser = yield* makePreviewBrowser({ cachesDir: realCachesDir, wait: "10 minutes" });
  return yield* makePagePreview(browser);
});

/** What the chat's bootstrap does: reports the document's height whenever it changes. */
const SIZE_BOOTSTRAP = `<script>
  new ResizeObserver(() => parent.postMessage({
    jsonrpc: "2.0",
    method: "ui/notifications/size-changed",
    params: { height: document.documentElement.getBoundingClientRect().height },
  }, "*")).observe(document.documentElement);
</script>`;

const pageDocument = (body: string) =>
  `<!doctype html><html><head><style>html,body{margin:0}</style>${SIZE_BOOTSTRAP}</head><body>${body}</body></html>`;

describe.runIf(REAL_BROWSER)("PagePreview in the real browser", () => {
  it.live(
    "screenshots the frame at the height the page reports, with the page's console",
    () =>
      Effect.gen(function* () {
        const pagePreview = yield* realPagePreview;
        const preview = yield* pagePreview.preview({
          document: pageDocument(
            [
              '<div style="height:300px;background:#3355ff"></div>',
              "<script>",
              'console.log("ready", 3); console.info("info line");',
              'console.warn("careful"); console.error("boom");',
              "</script>",
              '<script>throw new Error("broken chart");</script>',
              '<script>function fail() { throw "plain value"; } fail();</script>',
            ].join(""),
          ),
          width: 400,
        });

        const png = Buffer.from(preview.png, "base64");
        expect(png.readUInt32BE(0)).toBe(0x89504e47);
        expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([400, 300]);
        expect(preview).toMatchObject({ width: 400, contentHeight: 300, capturedHeight: 300 });
        expect(preview.consoleMessages).toEqual(
          expect.arrayContaining([
            { level: "log", text: "ready 3" },
            { level: "info", text: "info line" },
            { level: "warning", text: "careful" },
            { level: "error", text: "boom" },
            { level: "error", text: expect.stringMatching(/^Error: broken chart\n\s+at /) },
            {
              level: "error",
              text: expect.stringMatching(/^Uncaught plain value\n\s+at fail \(about:srcdoc:/),
            },
          ]),
        );
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    REAL_BROWSER_TIMEOUT,
  );

  it.live(
    "follows a page that changes height when its frame is sized, a few rounds at most",
    () =>
      Effect.gen(function* () {
        const pagePreview = yield* realPagePreview;
        // Reports 100px, then grows once its frame is resized to that.
        const grows = yield* pagePreview.preview({
          document: pageDocument(
            '<div id="box" style="height:100px"></div><script>addEventListener("resize", () => { document.getElementById("box").style.height = "300px"; });</script>',
          ),
          width: 400,
        });
        const png = Buffer.from(grows.png, "base64");
        expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([400, 300]);
        expect(grows).toMatchObject({ contentHeight: 300, capturedHeight: 300 });

        // Always 20px taller than its frame: the capture stops following it.
        const endless = yield* pagePreview.preview({
          document: pageDocument('<div style="height:calc(100vh + 20px)"></div>'),
          width: 400,
        });
        expect(endless.capturedHeight).toBeLessThan(endless.contentHeight);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    REAL_BROWSER_TIMEOUT,
  );

  it.live(
    "captures a page that never reports a height at the frame's initial height",
    () =>
      Effect.gen(function* () {
        const pagePreview = yield* realPagePreview;
        const preview = yield* pagePreview.preview({ document: "<p>No bootstrap</p>", width: 320 });

        const png = Buffer.from(preview.png, "base64");
        expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([320, 150]);
        expect(preview).toMatchObject({ contentHeight: 0, capturedHeight: 150 });
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    REAL_BROWSER_TIMEOUT,
  );

  it.live(
    "measures every width with a fresh load each",
    () =>
      Effect.gen(function* () {
        const pagePreview = yield* realPagePreview;
        // Like a D3 chart, the page sizes itself from the width once, at load.
        const heights = yield* pagePreview.measure({
          document: pageDocument(
            '<div id="chart"></div><script>document.getElementById("chart").style.height = innerWidth / 2 + "px";</script>',
          ),
          widths: [800, 360, 600],
        });

        expect(heights).toEqual(
          Option.some([
            [360, 180],
            [600, 300],
            [800, 400],
          ]),
        );
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    REAL_BROWSER_TIMEOUT,
  );

  it.live(
    "keeps the page off this machine, its network, and its files",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        // Each line of the page below is a way out that the browser's own
        // checks do not all stop.
        const requests: Array<string> = [];
        const server = yield* Effect.acquireRelease(
          Effect.callback<NodeHttp.Server>((resume) => {
            const listening = NodeHttp.createServer((request, response) => {
              requests.push(`${request.url} ${request.headers["sec-purpose"] ?? ""}`);
              response.end("<p>LOCAL</p>");
            });
            listening.listen(0, "127.0.0.1", () => resume(Effect.succeed(listening)));
          }),
          (listening) =>
            Effect.callback<void>((resume) => {
              listening.close(() => resume(Effect.void));
            }),
        );
        const datagrams: Array<string> = [];
        const udp = yield* Effect.acquireRelease(
          Effect.callback<NodeDgram.Socket>((resume) => {
            const socket = NodeDgram.createSocket("udp4");
            socket.on("message", (message) => datagrams.push(message.toString("hex")));
            socket.bind(0, "127.0.0.1", () => resume(Effect.succeed(socket)));
          }),
          (socket) =>
            Effect.callback<void>((resume) => {
              socket.close(() => resume(Effect.void));
            }),
        );
        const directory = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "threadlines-preview-files-",
        });
        const secret = path.join(directory, "secret.js");
        yield* fileSystem.writeFileString(secret, 'window.secret = "abc123";');
        const secretUrl = NodeURL.pathToFileURL(secret).href;
        const address = server.address();
        const origin = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
        const stun = `stun:127.0.0.1:${udp.address().port}`;

        const pagePreview = yield* realPagePreview;
        const preview = yield* pagePreview.preview({
          document: pageDocument(
            [
              `<script src="${secretUrl}"></script>`,
              `<img src="${origin}/x.png"><iframe src="${origin}/"></iframe>`,
              `<script type="speculationrules">{"prefetch":[{"source":"list","urls":["${origin}/prefetch"]}]}</script>`,
              `<script>fetch("${origin}/").catch(() => {}); new WebSocket("ws${origin.slice(4)}/socket");`,
              `fetch("http://threadlines-preview.localhost/").catch(() => {});`,
              `try { const peer = new RTCPeerConnection({ iceServers: [{ urls: "${stun}" }] });`,
              `peer.createDataChannel("x"); peer.createOffer().then((offer) => peer.setLocalDescription(offer));`,
              `} catch {}`,
              `addEventListener("load", () => console.log("secret:", window.secret ?? "none"));`,
              `window.open("${origin}/popup"); top.location.href = "${origin}/navigate";</script>`,
            ].join(""),
          ),
          width: 400,
        });

        expect(requests).toEqual([]);
        expect(datagrams).toEqual([]);
        const texts = preview.consoleMessages.map((message) => message.text);
        expect(texts).toContain("secret: none");
        expect(texts.join(" ")).not.toContain("abc123");
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    REAL_BROWSER_TIMEOUT,
  );
});
