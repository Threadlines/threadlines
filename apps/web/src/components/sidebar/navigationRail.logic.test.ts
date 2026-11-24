import { describe, expect, it } from "vite-plus/test";

import { resolveSelectedDestination } from "./navigationRail.logic";

describe("resolveSelectedDestination", () => {
  it("selects the page's destination, and General Chats for a general chat", () => {
    const selected = (pathname: string, openThreadIsGeneralChat = false) =>
      resolveSelectedDestination({
        pathname,
        openThreadIsGeneralChat,
        generalChatsInThreads: false,
      });

    expect(selected("/")).toBe("threads");
    expect(selected("/environment-local/thread-1")).toBe("threads");
    expect(selected("/draft/draft-1")).toBe("threads");
    expect(selected("/environment-local/thread-1", true)).toBe("chats");
    expect(selected("/chats")).toBe("chats");
    expect(selected("/terminals")).toBe("terminals");
    expect(selected("/pull-requests")).toBe("pull-requests");
    expect(selected("/fleet")).toBe("fleet");
    expect(selected("/scheduled")).toBe("scheduled");
    expect(selected("/usage")).toBe("usage");
    expect(selected("/settings/threads")).toBe("settings");
    // A thread whose id merely starts like a page is still a thread.
    expect(selected("/fleetwood/thread-1")).toBe("threads");
  });

  it("selects Threads for a general chat and the old chats page when the chats are a section of it", () => {
    const selected = (pathname: string, openThreadIsGeneralChat = false) =>
      resolveSelectedDestination({
        pathname,
        openThreadIsGeneralChat,
        generalChatsInThreads: true,
      });

    expect(selected("/environment-local/thread-1", true)).toBe("threads");
    expect(selected("/chats")).toBe("threads");
    expect(selected("/fleet")).toBe("fleet");
  });
});
