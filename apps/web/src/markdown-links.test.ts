import { describe, expect, it } from "vite-plus/test";

import {
  findBareImagePaths,
  findBareLocalhostUrls,
  localhostUrlFromText,
  resolveMarkdownFileLinkMeta,
  resolveMarkdownFileLinkTarget,
  rewriteMarkdownFileUriHref,
  toMarkdownFileUrlHref,
} from "./markdown-links";

describe("rewriteMarkdownFileUriHref", () => {
  it("rewrites file uri hrefs into direct path hrefs", () => {
    expect(rewriteMarkdownFileUriHref("file:///Users/julius/project/src/main.ts#L42")).toBe(
      "/Users/julius/project/src/main.ts#L42",
    );
  });

  it("preserves encoded octets so file paths are decoded only once later", () => {
    expect(rewriteMarkdownFileUriHref("file:///Users/julius/project/file%2520name.md")).toBe(
      "/Users/julius/project/file%2520name.md",
    );
  });

  it("normalizes file uri hrefs for windows drive paths", () => {
    expect(
      rewriteMarkdownFileUriHref(
        "file:///D:/Programme/threadlines/apps/web/src/components/chat/OpenInPicker.tsx#L69",
      ),
    ).toBe("D:/Programme/threadlines/apps/web/src/components/chat/OpenInPicker.tsx#L69");
  });

  it("unwraps angle-bracketed file uri hrefs", () => {
    expect(
      rewriteMarkdownFileUriHref(
        " <file:///D:/Programme/threadlines/apps/web/src/markdown-links.ts> ",
      ),
    ).toBe("D:/Programme/threadlines/apps/web/src/markdown-links.ts");
  });
});

describe("resolveMarkdownFileLinkTarget", () => {
  it("resolves absolute posix file paths", () => {
    expect(resolveMarkdownFileLinkTarget("/Users/julius/project/AGENTS.md")).toBe(
      "/Users/julius/project/AGENTS.md",
    );
  });

  it("resolves relative file paths against cwd", () => {
    expect(resolveMarkdownFileLinkTarget("src/processRunner.ts:71", "/Users/julius/project")).toBe(
      "/Users/julius/project/src/processRunner.ts:71",
    );
  });

  it("does not treat filename line references as external schemes", () => {
    expect(resolveMarkdownFileLinkTarget("script.ts:10", "/Users/julius/project")).toBe(
      "/Users/julius/project/script.ts:10",
    );
  });

  it("resolves bare file names against cwd", () => {
    expect(resolveMarkdownFileLinkTarget("AGENTS.md", "/Users/julius/project")).toBe(
      "/Users/julius/project/AGENTS.md",
    );
  });

  it("maps #L line anchors to editor line suffixes", () => {
    expect(resolveMarkdownFileLinkTarget("/Users/julius/project/src/main.ts#L42C7")).toBe(
      "/Users/julius/project/src/main.ts:42:7",
    );
  });

  it("ignores external urls", () => {
    expect(resolveMarkdownFileLinkTarget("https://example.com/docs")).toBeNull();
    expect(resolveMarkdownFileLinkTarget("localhost:5173")).toBeNull();
    expect(resolveMarkdownFileLinkTarget("127.0.0.1:5173")).toBeNull();
  });

  it("does not double-decode file URLs", () => {
    expect(resolveMarkdownFileLinkTarget("file:///Users/julius/project/file%2520name.md")).toBe(
      "/Users/julius/project/file%20name.md",
    );
  });

  it("keeps the directory name for POSIX paths ending in a separator", () => {
    expect(resolveMarkdownFileLinkMeta("/Users/will/badcode/")).toMatchObject({
      basename: "badcode",
      filePath: "/Users/will/badcode/",
    });
  });

  it("keeps the directory name for Windows paths ending in a separator", () => {
    expect(resolveMarkdownFileLinkMeta("C:\\Users\\will\\badcode\\")).toMatchObject({
      basename: "badcode",
      filePath: "C:\\Users\\will\\badcode\\",
    });
  });

  it("formats tooltip display paths relative to the cwd when possible", () => {
    expect(
      resolveMarkdownFileLinkMeta(
        "file:///C:/Users/mike/dev-stuff/threadlines/apps/web/src/session-logic.ts#L501",
        "C:/Users/mike/dev-stuff/threadlines",
      ),
    ).toMatchObject({
      displayPath: "threadlines/apps/web/src/session-logic.ts:501",
    });
  });

  it("formats tooltip display paths relative to the cwd for slash-prefixed windows paths", () => {
    expect(
      resolveMarkdownFileLinkMeta(
        "/C:/Users/mike/dev-stuff/threadlines/apps/web/src/components/chat/MessagesTimeline.virtualization.browser.tsx",
        "C:/Users/mike/dev-stuff/threadlines",
      ),
    ).toMatchObject({
      displayPath:
        "threadlines/apps/web/src/components/chat/MessagesTimeline.virtualization.browser.tsx",
    });
  });

  it("normalizes slash-prefixed windows drive paths before resolving", () => {
    expect(
      resolveMarkdownFileLinkTarget(
        "/D:/Programme/threadlines/apps/web/src/components/chat/OpenInPicker.tsx#L69",
      ),
    ).toBe("D:/Programme/threadlines/apps/web/src/components/chat/OpenInPicker.tsx:69");
  });

  it("resolves angle-bracketed windows drive paths", () => {
    expect(
      resolveMarkdownFileLinkTarget(
        "</D:/Programme/threadlines/apps/web/src/components/ChatMarkdown.tsx:1>",
      ),
    ).toBe("D:/Programme/threadlines/apps/web/src/components/ChatMarkdown.tsx:1");
  });

  it("does not treat app routes as file links", () => {
    expect(resolveMarkdownFileLinkTarget("/chat/settings")).toBeNull();
  });
});

describe("toMarkdownFileUrlHref", () => {
  it("formats absolute posix file paths as encoded file urls", () => {
    expect(toMarkdownFileUrlHref("/Users/demo/Downloads/Quarterly Report - Q3.pdf")).toBe(
      "file:///Users/demo/Downloads/Quarterly%20Report%20-%20Q3.pdf",
    );
  });

  it("preserves line anchors for copied file links", () => {
    expect(toMarkdownFileUrlHref("/Users/demo/project/src/main.ts", { line: 42, column: 7 })).toBe(
      "file:///Users/demo/project/src/main.ts#L42C7",
    );
  });

  it("formats windows drive paths as file urls", () => {
    expect(toMarkdownFileUrlHref("D:/Programme/threadlines/file name.ts")).toBe(
      "file:///D:/Programme/threadlines/file%20name.ts",
    );
  });
});

describe("findBareLocalhostUrls", () => {
  it("finds dev server addresses written without a scheme", () => {
    expect(findBareLocalhostUrls("Server ready on localhost:5173")).toEqual([
      { start: 16, end: 30, text: "localhost:5173", url: "http://localhost:5173" },
    ]);
  });

  it("keeps the path and query attached", () => {
    const [match] = findBareLocalhostUrls("Open 127.0.0.1:8080/admin?tab=logs now");

    expect(match?.text).toBe("127.0.0.1:8080/admin?tab=logs");
    expect(match?.url).toBe("http://127.0.0.1:8080/admin?tab=logs");
  });

  it("finds every address in a line", () => {
    expect(
      findBareLocalhostUrls("api on 0.0.0.0:3000 and web on localhost:5173").map(
        (match) => match.url,
      ),
    ).toEqual(["http://0.0.0.0:3000", "http://localhost:5173"]);
  });

  it("leaves the word localhost alone when it names no port", () => {
    expect(findBareLocalhostUrls("bound to localhost only")).toEqual([]);
  });

  it("does not match inside a longer word or an address already written in full", () => {
    expect(findBareLocalhostUrls("mylocalhost:5173")).toEqual([]);
    expect(findBareLocalhostUrls("see http://localhost:5173")).toEqual([]);
    expect(findBareLocalhostUrls("localhost:5173preview")).toEqual([]);
    expect(findBareLocalhostUrls("localhost:123456")).toEqual([]);
    expect(findBareLocalhostUrls("localhost:5173.example")).toEqual([]);
  });

  it("drops sentence punctuation that is not part of the address", () => {
    expect(findBareLocalhostUrls("Try localhost:5173.").map((match) => match.text)).toEqual([
      "localhost:5173",
    ]);
    expect(findBareLocalhostUrls("(localhost:5173/app)").map((match) => match.text)).toEqual([
      "localhost:5173/app",
    ]);
  });
});

describe("localhostUrlFromText", () => {
  it("accepts a whole-string address with or without a scheme", () => {
    expect(localhostUrlFromText("localhost:5173")).toBe("http://localhost:5173");
    expect(localhostUrlFromText("http://localhost:3000/foo")).toBe("http://localhost:3000/foo");
    expect(localhostUrlFromText("https://127.0.0.1:8443")).toBe("https://127.0.0.1:8443");
  });

  it("allows a scheme without a port, but never a bare host", () => {
    expect(localhostUrlFromText("http://localhost/health")).toBe("http://localhost/health");
    expect(localhostUrlFromText("localhost")).toBeNull();
    expect(localhostUrlFromText("localhost/app")).toBeNull();
  });

  it("rejects anything that is not entirely an address", () => {
    expect(localhostUrlFromText("run localhost:5173")).toBeNull();
    expect(localhostUrlFromText("localhost:5173 and more")).toBeNull();
    expect(localhostUrlFromText("example.com:5173")).toBeNull();
  });
});

describe("findBareImagePaths", () => {
  it("finds unambiguous image paths written in prose", () => {
    const windowsPath = String.raw`C:\Users\me\AppData\Local\Temp\ui.png`;
    expect(
      findBareImagePaths(`Saved to ${windowsPath} and /tmp/before.jpg, plus ./docs/after.webp`).map(
        (match) => match.text,
      ),
    ).toEqual([windowsPath, "/tmp/before.jpg", "./docs/after.webp"]);
  });

  it("drops sentence punctuation that is not part of the path", () => {
    expect(findBareImagePaths("See ~/shots/home.png.").map((match) => match.text)).toEqual([
      "~/shots/home.png",
    ]);
    expect(findBareImagePaths("(../out/diff.gif)").map((match) => match.text)).toEqual([
      "../out/diff.gif",
    ]);
  });

  it("ignores bare names, non-image paths, and paths inside longer runs", () => {
    expect(findBareImagePaths("open screenshot.png now")).toEqual([]);
    expect(findBareImagePaths("edit ./src/main.ts now")).toEqual([]);
    expect(findBareImagePaths("https://example.com/logo.png")).toEqual([]);
  });
});
