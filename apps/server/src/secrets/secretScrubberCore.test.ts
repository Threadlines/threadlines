import { EventId, type ProviderRuntimeEvent, ThreadId, TurnId } from "@threadlines/contracts";
import { describe, expect, it } from "vite-plus/test";

import { makeSecretScrubber } from "./SecretScrubber.ts";

const KEY = "sk_test_51HvQq2abc";
const SESSION = ThreadId.make("session-1");
const TURN = TurnId.make("turn-1");
let counter = 0;

const base = () => ({
  eventId: EventId.make(`event-${(counter += 1)}`),
  provider: "codex",
  threadId: SESSION,
  createdAt: "2026-11-19T10:00:00.000Z",
  turnId: TURN,
});

const delta = (
  text: string,
  options?: {
    readonly itemId?: string;
    readonly streamKind?: string;
    readonly summaryIndex?: number;
  },
) =>
  ({
    ...base(),
    type: "content.delta",
    itemId: options?.itemId ?? "item-1",
    payload: {
      streamKind: options?.streamKind ?? "command_output",
      delta: text,
      ...(options?.summaryIndex !== undefined ? { summaryIndex: options.summaryIndex } : {}),
    },
    raw: { source: "codex.app-server.notification", method: "item/delta", payload: { b64: "x" } },
  }) as unknown as ProviderRuntimeEvent;

const event = (type: string, payload: unknown, extra?: object) =>
  ({ ...base(), type, payload, ...extra }) as unknown as ProviderRuntimeEvent;

function watching(...values: ReadonlyArray<readonly [string, string]>) {
  const scrubber = makeSecretScrubber();
  for (const [name, value] of values) scrubber.watch(name, value);
  return scrubber;
}

describe("hiding watched values in text", () => {
  it("hides a whole value, its JSON-escaped and URL-encoded forms, in strings and member names", () => {
    const quoted = 'p"ss/w+rd=12';
    const scrubber = watching(["STRIPE_SECRET_KEY", KEY], ["DB_PASSWORD", quoted]);
    const input = {
      out: `export STRIPE_SECRET_KEY=${KEY}`,
      nested: [{ json: JSON.stringify({ password: quoted }) }],
      url: `https://x.test/?p=${encodeURIComponent(quoted)}`,
      [KEY]: "as a member name",
    };
    const result = scrubber.scrubDeep(input);
    const text = JSON.stringify(result);
    expect(text).not.toContain(KEY);
    expect(text).not.toContain("ss/w+rd");
    expect(text).not.toContain(encodeURIComponent(quoted));
    expect(result.out).toBe("export STRIPE_SECRET_KEY=[STRIPE_SECRET_KEY hidden]");
    expect(Object.keys(result)).toContain("[STRIPE_SECRET_KEY hidden]");
  });

  it("hands back the same object when nothing matched, and never watches a short or plain value", () => {
    const scrubber = watching(["A", "localhost"], ["B", "12345678"], ["C", "ab1"], ["D", KEY]);
    const input = { text: "localhost:12345678 ab1", list: ["ok"] };
    expect(scrubber.scrubDeep(input)).toBe(input);
    expect(scrubber.watch("E", "]1234567x")).toBe(false);
  });

  it("finds a long value by its head and hides it as far as the text agrees, even cut short", () => {
    const pem = `-----BEGIN KEY-----\n${"A1b2C3d4".repeat(100)}\n-----END KEY-----`;
    const scrubber = watching(["PEM", pem]);
    expect(scrubber.scrubText(`key: ${pem} done`).text).toBe("key: [PEM hidden] done");
    const cut = pem.slice(0, 500);
    expect(scrubber.scrubText(`partial ${cut}`).text).toBe("partial [PEM hidden]");
  });

  it("cuts a provider snapshot that stops 4 or more characters into a value, not 3", () => {
    const scrubber = watching(["K", KEY]);
    const snapshot = (text: string) =>
      scrubber.scrubRuntimeEvent(event("item.updated", { detail: text }))[0]?.payload;
    expect(snapshot(`x ${KEY.slice(0, 4)}`)).toEqual({ detail: "x " });
    expect(snapshot(`x ${KEY.slice(0, 3)}`)).toEqual({ detail: `x ${KEY.slice(0, 3)}` });
    // Text already joined is never cut: only whole values go.
    expect(scrubber.scrubDeep({ text: `x ${KEY.slice(0, 4)}` }).text).toBe(`x ${KEY.slice(0, 4)}`);
  });

  it("gives two values under one name different placeholders", () => {
    const scrubber = watching(["K", KEY], ["K", "sk_live_99zzQQ11"]);
    expect(scrubber.scrubText(`${KEY} sk_live_99zzQQ11`).text).toBe("[K hidden] [K 2 hidden]");
  });
});

describe("the registry", () => {
  it("past 200 values drops one whose file is gone, before an older one still live", () => {
    const scrubber = makeSecretScrubber();
    scrubber.watch("LIVE", "sk_live_0000aaaa", "request-live");
    scrubber.watch("GONE", "sk_gone_1111bbbb", "request-gone");
    scrubber.gone("request-gone");
    for (let index = 0; index < 199; index += 1) {
      scrubber.watch(`K${index}`, `sk_fill_${index}_zz9`, `request-${index}`);
    }
    expect(scrubber.scrubText("sk_live_0000aaaa").text).toBe("[LIVE hidden]");
    expect(scrubber.scrubText("sk_gone_1111bbbb").text).toBe("sk_gone_1111bbbb");
  });
});

describe("nothing watched", () => {
  it("hands back the very same event, alone", () => {
    const scrubber = makeSecretScrubber();
    const piece = delta(`token ${KEY}`);
    const out = scrubber.scrubRuntimeEvent(piece);
    expect(out).toHaveLength(1);
    expect(out[0]).toBe(piece);
  });
});

describe("holding a buffer's pieces (ingestion's holder)", () => {
  /** Runs pieces through one buffer's holder, releasing at the end as ingestion does. */
  function through(scrubber: ReturnType<typeof watching>, pieces: ReadonlyArray<string>) {
    let state: Parameters<typeof scrubber.holdPiece>[0];
    let out = "";
    for (const piece of pieces) {
      const held = scrubber.holdPiece(state, piece);
      out += held.out;
      state = held.state;
    }
    return out + (state?.held ?? "");
  }

  it("hides a value split across pieces, holding only what could start it", () => {
    const scrubber = watching(["K", KEY]);
    expect(through(scrubber, ["total ", "s", "k_te", "st_51Hv", "Qq2abc and more", " end"])).toBe(
      "total [K hidden] and more end",
    );
  });

  it("gives back a held tail that turned out not to be a value, intact and in order", () => {
    const scrubber = watching(["K", KEY]);
    expect(through(scrubber, ["build s", "k_tea is fine"])).toBe("build sk_tea is fine");
    expect(through(scrubber, ["Done with the tests"])).toBe("Done with the tests");
  });

  it("follows a long value arriving one character at a time", () => {
    const pem = `-----BEGIN-----${"x9".repeat(400)}`;
    const scrubber = watching(["PEM", pem]);
    expect(through(scrubber, [...`>> ${pem} <<`])).toBe(">> [PEM hidden] <<");
  });

  it("holds nothing when nothing is watched", () => {
    const scrubber = makeSecretScrubber();
    expect(scrubber.holdPiece(undefined, "sk_te")).toEqual({
      out: "sk_te",
      state: undefined,
      names: [],
    });
  });
});

describe("the provider hook", () => {
  it("hides a whole value in a piece and the provider's message, and never holds or cuts a piece", () => {
    const scrubber = watching(["K", KEY]);
    const [whole] = scrubber.scrubRuntimeEvent(delta(`total ${KEY} done`));
    expect(whole?.type === "content.delta" && whole.payload.delta).toBe("total [K hidden] done");
    expect(whole?.raw?.payload).toEqual({ hidden: true });
    const piece = delta("ends with sk_te");
    expect(scrubber.scrubRuntimeEvent(piece)).toEqual([piece]);
  });

  it("notices a hidden key once per name per turn", () => {
    const scrubber = watching(["K", KEY]);
    const first = scrubber.scrubRuntimeEvent(delta(KEY));
    const second = scrubber.scrubRuntimeEvent(delta(KEY));
    expect(first.map((entry) => entry.type)).toEqual(["content.delta", "runtime.warning"]);
    expect(second.map((entry) => entry.type)).toEqual(["content.delta"]);
  });
});

describe("questions and approvals", () => {
  it("shows a question hidden and puts the original back in its answer, and nothing else", () => {
    const scrubber = watching(["K", KEY]);
    const question = `Use ${KEY} for prod?`;
    const [shown] = scrubber.scrubRuntimeEvent(
      event(
        "user-input.requested",
        { questions: [{ id: question, question, options: [{ label: "Yes", description: "" }] }] },
        { requestId: "request-1" },
      ),
    );
    const hidden = (shown?.payload as { questions: Array<{ id: string }> } | undefined)
      ?.questions[0]?.id;
    expect(hidden).toBe("Use [K hidden] for prod?");
    const answer = scrubber.restoreAnswer(SESSION, "request-1", {
      [hidden ?? ""]: "Yes",
      other: "[K hidden]",
    });
    expect(answer).toEqual({ [question]: "Yes", other: "[K hidden]" });
  });
});

describe("review fixes", () => {
  it("hides the provider's whole message when a clean piece carries the key in it", () => {
    const scrubber = watching(["K", KEY]);
    const piece = {
      ...delta("ok"),
      raw: { source: "claude.sdk.message", payload: { results: [KEY, "ok"] } },
    } as unknown as ProviderRuntimeEvent;
    const [out] = scrubber.scrubRuntimeEvent(piece);
    expect(JSON.stringify(out)).not.toContain(KEY);
    expect(out?.type === "content.delta" && out.payload.delta).toBe("ok");
  });

  it("never lets a placeholder or notice spell out another watched key", () => {
    const scrubber = watching(["FIRST", "SERVICE_TOKEN"], ["SERVICE_TOKEN", KEY]);
    const out = scrubber.scrubRuntimeEvent(event("item.updated", { detail: `token ${KEY}` }));
    const text = JSON.stringify(out);
    expect(text).not.toContain("SERVICE_TOKEN");
    expect(text).toContain("[a saved key hidden]");
  });

  it("never cuts a member name or a question, and puts back only what a whole match rewrote", () => {
    const scrubber = watching(["K", "message-1234"], ["K2", "ABCD1234"]);
    const [warning] = scrubber.scrubRuntimeEvent(event("runtime.warning", { message: "ok" }));
    expect(warning?.payload).toEqual({ message: "ok" });
    const [shown] = scrubber.scrubRuntimeEvent(
      event("request.opened", { decision: "acceptABCD" }, { requestId: "r3" }),
    );
    // A question's or approval's text is never cut: some providers key answers by it.
    expect(shown?.payload).toEqual({ decision: "acceptABCD" });
    expect(scrubber.restoreAnswer(SESSION, "r3", "accept")).toBe("accept");
  });

  it("keeps two questions apart when hiding makes them the same text", () => {
    const value = "abc/12345";
    const scrubber = watching(["K", value]);
    const first = `Use ${value}?`;
    const second = `Use ${encodeURIComponent(value)}?`;
    const [shown] = scrubber.scrubRuntimeEvent(
      event(
        "user-input.requested",
        {
          questions: [
            { id: first, question: first },
            { id: second, question: second },
          ],
        },
        { requestId: "r4" },
      ),
    );
    const ids = (
      (shown?.payload as { questions: Array<{ id: string }> } | undefined)?.questions ?? []
    ).map((question) => question.id);
    expect(new Set(ids).size).toBe(2);
    expect(scrubber.restoreAnswer(SESSION, "r4", { [ids[0]!]: "A", [ids[1]!]: "B" })).toEqual({
      [first]: "A",
      [second]: "B",
    });
  });
});
