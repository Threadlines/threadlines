// @effect-diagnostics preferSchemaOverJson:off
import { assert, afterEach, describe, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as BitbucketApi from "../sourceControl/BitbucketApi.ts";
import * as BitbucketPullRequestProvider from "./BitbucketPullRequestProvider.ts";

const mockRequest = vi.fn<BitbucketApi.BitbucketApiShape["request"]>();

const layer = Layer.mock(BitbucketApi.BitbucketApi)({ request: mockRequest });

const repository = { cwd: "/workspaces/tools", repository: "acme/tools" };
const pullRequestPath = "/repositories/acme/tools/pullrequests/7";

const calls = () => mockRequest.mock.calls.map(([input]) => input);

const answer = (body: string) => Effect.succeed({ status: 200, body });

afterEach(() => {
  mockRequest.mockReset();
});

describe("BitbucketPullRequestProvider.listChangeRequests", () => {
  it.effect("asks for both closed states at once, since Bitbucket separates them", () =>
    Effect.gen(function* () {
      mockRequest.mockReturnValue(answer(JSON.stringify({ values: [] })));
      const provider = yield* BitbucketPullRequestProvider.make();

      yield* provider.listChangeRequests({ ...repository, state: "closed", limit: 30 });

      assert.equal(
        calls()[0]?.path,
        "/repositories/acme/tools/pullrequests?state=DECLINED&state=SUPERSEDED&pagelen=30&sort=-updated_on&fields=%2Bvalues.reviewers",
      );
    }).pipe(Effect.provide(layer)),
  );
});

describe("BitbucketPullRequestProvider.runAction", () => {
  it.effect("merges with the strategy Bitbucket names it by", () =>
    Effect.gen(function* () {
      mockRequest.mockReturnValue(answer(""));
      const provider = yield* BitbucketPullRequestProvider.make();

      yield* provider.runAction({
        ...repository,
        number: 7,
        action: "merge",
        mergeMethod: "rebase",
      });

      assert.deepStrictEqual(calls()[0], {
        method: "POST",
        path: `${pullRequestPath}/merge`,
        body: JSON.stringify({ merge_strategy: "rebase_fast_forward" }),
      });
    }).pipe(Effect.provide(layer)),
  );

  it.effect("closes a pull request by declining it", () =>
    Effect.gen(function* () {
      mockRequest.mockReturnValue(answer(""));
      const provider = yield* BitbucketPullRequestProvider.make();

      yield* provider.runAction({ ...repository, number: 7, action: "close" });

      assert.deepStrictEqual(calls()[0], {
        method: "POST",
        path: `${pullRequestPath}/decline`,
      });
    }).pipe(Effect.provide(layer)),
  );
});

describe("BitbucketPullRequestProvider.submitReview", () => {
  it.effect("posts the line comments, then the summary, then the refusal", () =>
    Effect.gen(function* () {
      mockRequest.mockReturnValue(answer(""));
      const provider = yield* BitbucketPullRequestProvider.make();

      yield* provider.submitReview({
        ...repository,
        number: 7,
        verdict: "request-changes",
        body: "Please split this.",
        comments: [
          { path: "a.ts", position: { kind: "added", newLine: 12 }, body: "New line" },
          { path: "b.ts", position: { kind: "deleted", oldLine: 7 }, body: "Old line" },
        ],
      });

      assert.deepStrictEqual(calls(), [
        {
          method: "POST",
          path: `${pullRequestPath}/comments`,
          body: JSON.stringify({ content: { raw: "New line" }, inline: { path: "a.ts", to: 12 } }),
        },
        {
          method: "POST",
          path: `${pullRequestPath}/comments`,
          body: JSON.stringify({ content: { raw: "Old line" }, inline: { path: "b.ts", from: 7 } }),
        },
        {
          method: "POST",
          path: `${pullRequestPath}/comments`,
          body: JSON.stringify({ content: { raw: "Please split this." } }),
        },
        { method: "POST", path: `${pullRequestPath}/request-changes` },
      ]);
    }).pipe(Effect.provide(layer)),
  );
});

describe("BitbucketPullRequestProvider.setThreadResolution", () => {
  it.effect("creates and deletes the resolution, which Bitbucket keeps as a sub-resource", () =>
    Effect.gen(function* () {
      mockRequest.mockReturnValue(answer(""));
      const provider = yield* BitbucketPullRequestProvider.make();

      yield* provider.setThreadResolution({
        ...repository,
        number: 7,
        threadId: "42",
        resolved: false,
      });

      assert.deepStrictEqual(calls()[0], {
        method: "DELETE",
        path: `${pullRequestPath}/comments/42/resolve`,
      });
    }).pipe(Effect.provide(layer)),
  );
});

describe("BitbucketPullRequestProvider.setReviewerRequest", () => {
  it.effect("writes the whole reviewer set back, since Bitbucket replaces rather than adds", () =>
    Effect.gen(function* () {
      mockRequest.mockImplementation((input) =>
        answer(
          input.method === "GET"
            ? JSON.stringify({
                id: 7,
                title: "Tidy the toolbox",
                state: "OPEN",
                source: { branch: { name: "feature/tidy" } },
                destination: { branch: { name: "main" } },
                created_on: "2026-08-30T10:00:00+00:00",
                updated_on: "2026-08-31T10:00:00+00:00",
                links: { html: { href: "https://bitbucket.org/acme/tools/pull-requests/7" } },
                reviewers: [{ uuid: "{abc}", nickname: "hubot" }],
              })
            : "",
        ),
      );
      const provider = yield* BitbucketPullRequestProvider.make();

      yield* provider.setReviewerRequest({
        ...repository,
        number: 7,
        reviewers: [{ id: "{def}", kind: "user" }],
        requested: true,
      });

      assert.deepStrictEqual(calls().at(-1), {
        method: "PUT",
        path: pullRequestPath,
        body: JSON.stringify({ reviewers: [{ uuid: "{abc}" }, { uuid: "{def}" }] }),
      });
    }).pipe(Effect.provide(layer)),
  );
});

describe("BitbucketPullRequestProvider.setReaction", () => {
  it.effect("refuses without writing, Bitbucket having no reaction to set", () =>
    Effect.gen(function* () {
      const provider = yield* BitbucketPullRequestProvider.make();

      const error = yield* provider
        .setReaction({ ...repository, number: 7, content: "thumbs-up", reacted: true })
        .pipe(Effect.flip);

      assert.equal(error.detail, "Bitbucket does not support reactions.");
      assert.deepStrictEqual(calls(), []);
    }).pipe(Effect.provide(layer)),
  );
});
