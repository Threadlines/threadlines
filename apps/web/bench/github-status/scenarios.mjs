// The scenarios. Each writes plain JSON into `context.out` as it goes (and
// saves after every step), so a stopped run keeps what it measured: per run,
// per change, how long each surface took to show it and how long the surfaces
// disagreed. Each run of a scenario has a fresh tab, thread and pull request
// of its own; see `eachRun` for one after another versus side by side.
import { ghRate, sleep } from "./lib.mjs";
import { readSurfaces, waitForSurfaces, watchUntil } from "./surfaces.mjs";

/** The changes a pull request goes through, in an order GitHub allows. */
export const FLIPS = {
  "checks pending→passing": {
    change: (pr) => {
      pr.checks = "success";
    },
    expect: { checks: "success" },
  },
  "draft→ready": {
    change: (pr) => {
      pr.isDraft = false;
    },
    expect: { composer: "open", sidebar: "open", chip: "open" },
  },
  "open→closed": {
    change: (pr, at) => {
      pr.state = "CLOSED";
      pr.closedAt = at;
    },
    expect: { composer: "closed", checks: "closed", sidebar: "closed", chip: "closed" },
  },
  "closed→reopened": {
    change: (pr) => {
      pr.state = "OPEN";
      pr.closedAt = null;
    },
    expect: { composer: "open", checks: "success", sidebar: "open", chip: "open" },
  },
  "open→merged": {
    change: (pr, at) => {
      pr.state = "MERGED";
      pr.mergedAt = at;
      pr.closedAt = at;
    },
    expect: { composer: "merged", checks: "merged", sidebar: "merged", chip: "merged" },
  },
};

const ALL_SURFACES = ["composer", "checks", "sidebar", "chip"];

let nextNumber = 100;

/** A thread on its own branch and worktree, with a pull request, and an agent reply linking it. */
async function pullRequestThread(stack, { slug, label, pr = {}, number = nextNumber++, say }) {
  const branch = `bench/${label}-${number}`;
  const { worktree, headSha } = stack.addBranch(slug, branch);
  stack.addPullRequest(slug, {
    number,
    title: `Bench ${label} ${number}`,
    headRefName: branch,
    headSha,
    ...pr,
  });
  const threadId = await stack.createThread({
    slug,
    title: `${label} ${number}`,
    branch,
    worktreePath: worktree,
  });
  const url = `https://github.com/${slug}/pull/${number}`;
  await stack.agentSays(threadId, say ?? `Opened ${url} for this.`);
  return { slug, number, branch, threadId, url };
}

function targetFor(thread, { key = "pr", composer }) {
  return { key, number: thread.number, url: thread.url, threadId: thread.threadId, composer };
}

/** `{ composer: "open" }` → `{ "pr.composer": "open" }`, keeping only the surfaces on screen. */
function prefixed(key, expect, surfaces) {
  return Object.fromEntries(
    Object.entries(expect)
      .filter(([surface]) => surfaces.includes(surface))
      .map(([surface, value]) => [`${key}.${surface}`, value]),
  );
}

/**
 * Runs `options.runs` copies of `run(index, view)`, each in a fresh tab of its
 * own: one after another, or with `options.parallel` side by side,
 * `options.staggerMs` apart. Side by side is faster but not one client: every
 * tab's sidebar watches every run's checkout through the server's shared git
 * status stream, so another tab's reads can update this one's surfaces.
 */
async function eachRun(stack, options, run) {
  const once = async (index) => {
    const view = await stack.newView();
    try {
      await run(index, view);
    } finally {
      await view.close();
    }
  };
  if (!options.parallel) {
    for (let index = 0; index < options.runs; index += 1) await once(index);
    return;
  }
  const results = await Promise.allSettled(
    Array.from({ length: options.runs }, async (_, index) => {
      await sleep(index * options.staggerMs);
      await once(index);
    }),
  );
  const failure = results.find((result) => result.status === "rejected");
  if (failure) throw failure.reason;
}

/**
 * A random wait before a change, so runs meet the app's polls at different
 * points in their cycles rather than at the same offset from the page load.
 */
async function jitter(options) {
  const ms = Math.round(Math.random() * options.jitterMs);
  await sleep(ms);
  return Number((ms / 1000).toFixed(1));
}

/**
 * Applies one change at `t0` and times every expected surface. A surface that
 * already showed the new value before the change is marked `alreadyShown`:
 * it never showed the old state, so its lag says nothing.
 *
 * `gh` is every call the server made in the window, for all clients: with
 * runs side by side it is not this run's cost (scenario E measures cost).
 */
async function timeFlip(stack, view, options, { thread, name, surfaces, key = "pr", targets }) {
  const flip = FLIPS[name];
  const expect = prefixed(key, flip.expect, surfaces);
  const jitterS = await jitter(options);
  const quiet = await stack.waitForQuietGh({ idleMs: 3_000, minMs: 0, maxMs: 30_000 });
  const before = await readSurfaces(view.page, targets);
  const t0 = stack.flip(thread.slug, thread.number, flip.change);
  const watched = await watchUntil(view.page, { targets, expect, t0, capMs: options.capMs });
  const alreadyShown = Object.keys(expect).filter((surface) => {
    const [targetKey, name_] = surface.split(".");
    return before[targetKey]?.[name_] === expect[surface];
  });
  const ghWindow = { from: t0, to: Date.now() };
  return {
    flip: name,
    jitterS,
    quietBefore: quiet,
    before,
    lags: watched.lags,
    alreadyShown,
    disagreementS: watched.disagreementS,
    timedOut: watched.timedOut,
    final: watched.final,
    changes: watched.changes,
    ghWindow,
    ghAllClients: ghRate(stack.readGhCalls(), ghWindow.from, ghWindow.to),
  };
}

function summarizeInitial(initial) {
  return {
    convergedS: initial.timedOut ? null : initial.waitedS,
    lags: initial.lags,
    final: initial.final,
    disagreementS: initial.disagreementS,
    changes: initial.changes,
  };
}

/** A: the page shows the thread whose pull request changes. */
export async function scenarioA(stack, options, { out, save }) {
  out.runs = [];
  await stack.parkMainView();
  await eachRun(stack, options, async (index, view) => {
    const thread = await pullRequestThread(stack, {
      slug: "bench/alpha",
      label: "a",
      pr: { isDraft: true, checks: "pending" },
    });
    await view.openThread(thread.threadId);
    const targets = [targetFor(thread, { composer: true })];
    const initial = await waitForSurfaces(view.page, {
      targets,
      expect: {
        "pr.composer": "draft",
        "pr.checks": "pending",
        "pr.sidebar": "draft",
        "pr.chip": "draft",
      },
      timeoutMs: 60_000,
    });
    await stack.waitForQuietGh({ maxMs: 30_000 });
    const record = { run: index + 1, thread, initial: summarizeInitial(initial), flips: [] };
    out.runs.push(record);
    save();
    for (const name of [
      "checks pending→passing",
      "draft→ready",
      "open→closed",
      "closed→reopened",
      "open→merged",
    ]) {
      record.flips.push(
        await timeFlip(stack, view, options, { thread, name, surfaces: ALL_SURFACES, targets }),
      );
      save();
      console.log(`A run ${index + 1}: ${name}`, JSON.stringify(record.flips.at(-1).lags));
    }
    await stack.archiveThread(thread.threadId);
  });
}

/** B: another thread is open; the changing pull request is only in the sidebar. */
export async function scenarioB(stack, options, { out, save }) {
  await stack.parkMainView();
  const viewed = await pullRequestThread(stack, { slug: "bench/beta", label: "b-view" });
  out.viewedThread = viewed;
  out.runs = [];
  await eachRun(stack, options, async (index, view) => {
    const thread = await pullRequestThread(stack, {
      slug: "bench/alpha",
      label: "b",
      pr: { isDraft: true, checks: "success" },
    });
    await view.openThread(viewed.threadId);
    const targets = [targetFor(thread, { composer: false })];
    const initial = await waitForSurfaces(view.page, {
      targets,
      expect: { "pr.sidebar": "draft" },
      timeoutMs: 60_000,
    });
    await stack.waitForQuietGh({ maxMs: 30_000 });
    const record = { run: index + 1, thread, initial: summarizeInitial(initial), flips: [] };
    out.runs.push(record);
    save();
    for (const name of ["draft→ready", "open→closed", "closed→reopened", "open→merged"]) {
      record.flips.push(
        await timeFlip(stack, view, options, { thread, name, surfaces: ["sidebar"], targets }),
      );
      save();
      console.log(`B run ${index + 1}: ${name}`, JSON.stringify(record.flips.at(-1).lags));
    }
    await stack.archiveThread(thread.threadId);
  });
}

/**
 * C: the pull request merges while nobody is looking (window blurred but
 * visible, or hidden) for a fixed `awayMs`. Times each surface from attention
 * coming back, and notes the ones that had caught up while it was away.
 */
export async function scenarioC(stack, options, { out, save }) {
  out.runs = [];
  await stack.parkMainView();
  for (const mode of ["blurred", "hidden"]) {
    await eachRun(stack, options, async (index, view) => {
      const thread = await pullRequestThread(stack, { slug: "bench/alpha", label: `c-${mode}` });
      await view.openThread(thread.threadId);
      const targets = [targetFor(thread, { composer: true })];
      const initial = await waitForSurfaces(view.page, {
        targets,
        expect: {
          "pr.composer": "open",
          "pr.checks": "success",
          "pr.sidebar": "open",
          "pr.chip": "open",
        },
        timeoutMs: 60_000,
      });
      await stack.waitForQuietGh({ maxMs: 30_000 });
      const record = { mode, run: index + 1, thread, initial: summarizeInitial(initial) };
      out.runs.push(record);
      save();
      record.pageSaw = await view.setAttention(mode);
      await sleep(5_000);
      record.jitterS = await jitter(options);
      const expect = prefixed("pr", FLIPS["open→merged"].expect, ALL_SURFACES);
      const t0 = stack.flip(thread.slug, thread.number, FLIPS["open→merged"].change);
      const away = await watchUntil(view.page, {
        targets,
        expect,
        t0,
        capMs: options.awayMs,
        sampleMs: 1_000,
        fixedDuration: true,
      });
      const t1 = Date.now();
      Object.assign(record, {
        awayS: Number(((t1 - t0) / 1000).toFixed(1)),
        caughtUpWhileAway: Object.keys(expect).filter((name) => away.lags[name] !== null),
        lagsWhileAway: away.lags,
        changes: away.changes,
        awayGhWindow: { from: t0, to: t1 },
      });
      save();
      record.pageSawBack = await view.setAttention("focused");
      const back = await watchUntil(view.page, { targets, expect, t0: t1, capMs: options.capMs });
      Object.assign(record, {
        lagsAfterReturn: back.lags,
        disagreementAfterReturnS: back.disagreementS,
        timedOut: back.timedOut,
        changes: [
          ...away.changes,
          ...back.changes.map((change) => ({ ...change, afterReturn: true })),
        ],
        returnGhWindow: { from: t1, to: Date.now() },
      });
      save();
      console.log(
        `C ${mode} run ${index + 1}`,
        JSON.stringify(record.lagsAfterReturn),
        "caught up while away:",
        record.caughtUpWhileAway,
      );
      await stack.archiveThread(thread.threadId);
    });
  }
}

/** The behind-remote count the chat header shows, or null when it shows none. */
async function readBehindCount(page) {
  return page.evaluate(() => {
    const label =
      document.querySelector("[data-header-source-changes]")?.getAttribute("aria-label") ?? "";
    const match = /(\d+) commits? behind the remote/u.exec(label);
    return match ? Number(match[1]) : null;
  });
}

/** From a thread in another project: New thread, then pick `projectTitle` in the hero. */
async function startDraftIn(page, projectTitle) {
  await page.locator('[data-testid="new-thread-button"]').click();
  const picker = page.locator('h2 button[aria-haspopup="menu"]');
  await picker.waitFor({ timeout: 15_000 });
  await picker.click();
  const item = page
    .locator('[role="menuitem"]')
    .filter({ hasText: new RegExp(`${projectTitle}$`, "u") });
  await item.first().waitFor({ timeout: 10_000 });
  const t0 = Date.now();
  await item.first().click();
  return t0;
}

/**
 * Seconds from `t0` until the header shows `expected` and keeps it for 10 s
 * (the same hold as the other surfaces); null if not by the cap.
 */
async function timeBehindCount(page, expected, t0, capMs) {
  const holdMs = 10_000;
  const seen = [];
  let last;
  let since = null;
  while (Date.now() - t0 < capMs) {
    const at = Date.now();
    const count = await readBehindCount(page).catch(() => undefined);
    if (count !== last) {
      seen.push({ s: Number(((at - t0) / 1000).toFixed(2)), count });
      last = count;
    }
    since = count === expected ? (since ?? at) : null;
    if (since !== null && at - since >= holdMs) {
      return { lagS: Number(((since - t0) / 1000).toFixed(2)), seen };
    }
    await sleep(250);
  }
  return { lagS: null, seen };
}

/** The server's finished fetches of one repository from `from` on, in seconds from `from`. */
function fetchesOf(stack, name, from) {
  return stack
    .readGitRemoteCalls()
    .filter((call) => call.repo === name && call.service === "git-upload-pack" && call.t >= from)
    .map((call) => Number(((call.t - from) / 1000).toFixed(1)));
}

/**
 * D: a teammate pushed to main; the user starts a new thread and picks the
 * project. Times the header's ↓N, with the Source panel closed.
 *   cold: a project the server has never fetched, added with the remote
 *         already ahead and picked as soon as it exists. The server's first
 *         fetch may land before the pick; `firstFetchFromPickS` says when.
 *   warm: the same project later. The run waits for the server's own next
 *         fetch of it, then the teammate pushes right after, so the answer the
 *         server holds is stale until something fetches again.
 *   watched: as warm, but the tab is already showing a thread on the
 *         project's checkout, so its status is watched before New thread
 *         opens a draft there (no project to pick). Timed from the push.
 */
export async function scenarioD(stack, options, { out, save, home }) {
  out.runs = [];
  await stack.parkMainView();
  await eachRun(stack, options, async (run, view) => {
    const slug = `bench/delta${run + 1}`;
    const repo = stack.addRepo(slug);
    const coldCount = run + 2;
    stack.peerPush(slug, coldCount);
    await view.openThread(home.threadId);
    const createdAt = Date.now();
    await stack.createProject(slug);
    const coldT0 = await startDraftIn(view.page, repo.name);
    const cold = await timeBehindCount(view.page, coldCount, coldT0, options.capMs);
    const coldFetches = fetchesOf(stack, repo.name, createdAt);
    const coldRecord = {
      kind: "cold",
      slug,
      expected: coldCount,
      ...cold,
      createdToPickS: Number(((coldT0 - createdAt) / 1000).toFixed(1)),
      lagFromCreationS:
        cold.lagS === null ? null : Number((cold.lagS + (coldT0 - createdAt) / 1000).toFixed(2)),
      firstFetchFromPickS:
        coldFetches.length === 0
          ? null
          : Number((coldFetches[0] - (coldT0 - createdAt) / 1000).toFixed(1)),
    };
    out.runs.push(coldRecord);
    save();
    console.log(`D cold run ${run + 1}`, JSON.stringify(coldRecord));

    await view.openThread(home.threadId);
    // The server's own next fetch of this repository; the push goes right after it.
    const fetchedAt = await waitForServerFetch(stack, repo.name, options.capMs);
    await sleep(2_000);
    const warmCount = coldCount + 1;
    stack.peerPush(slug, 1);
    const pushedAt = Date.now();
    const warmT0 = await startDraftIn(view.page, repo.name);
    const warm = await timeBehindCount(view.page, warmCount, warmT0, options.capMs);
    const warmRecord = {
      kind: "warm",
      slug,
      expected: warmCount,
      // Without a fetch just before the push this is not the warm case.
      valid: fetchedAt !== null,
      serverFetchedBeforePushS:
        fetchedAt === null ? null : Number(((pushedAt - fetchedAt) / 1000).toFixed(1)),
      ...warm,
      fetchesAfterPickS: fetchesOf(stack, repo.name, warmT0),
    };
    out.runs.push(warmRecord);
    save();
    console.log(`D warm run ${run + 1}`, JSON.stringify(warmRecord));

    // Watched: the tab already shows a thread on the project's checkout, so
    // its status is being watched when New thread opens a draft there.
    const watcher = await stack.createThread({ slug, title: `${repo.name} checkout` });
    await view.openThread(watcher);
    const watchedFetchedAt = await waitForServerFetch(stack, repo.name, options.capMs);
    await sleep(2_000);
    const watchedCount = warmCount + 1;
    stack.peerPush(slug, 1);
    const watchedPushedAt = Date.now();
    await view.page.locator('[data-testid="new-thread-button"]').click();
    const watched = await timeBehindCount(view.page, watchedCount, watchedPushedAt, options.capMs);
    const watchedRecord = {
      kind: "watched",
      slug,
      expected: watchedCount,
      valid: watchedFetchedAt !== null,
      serverFetchedBeforePushS:
        watchedFetchedAt === null
          ? null
          : Number(((watchedPushedAt - watchedFetchedAt) / 1000).toFixed(1)),
      ...watched,
      fetchesAfterPickS: fetchesOf(stack, repo.name, watchedPushedAt),
    };
    out.runs.push(watchedRecord);
    save();
    console.log(`D watched run ${run + 1}`, JSON.stringify(watchedRecord));
    await stack.archiveThread(watcher);
  });
}

/**
 * When the server next finishes a fetch of `name` that it started from now on
 * (ms), waiting up to `capMs`; null if it does not.
 */
async function waitForServerFetch(stack, name, capMs) {
  const from = Date.now();
  while (Date.now() - from < capMs) {
    const fetch = stack
      .readGitRemoteCalls()
      .find(
        (call) =>
          call.repo === name &&
          call.service === "git-upload-pack" &&
          call.t >= from &&
          call.exit === 0,
      );
    if (fetch) return fetch.end;
    await sleep(500);
  }
  return null;
}

/**
 * E: `gh` runs per minute with nothing changing, by command kind, for a
 * focused window, a blurred one and a hidden one. Each starts with a window
 * reported on its own (the page load, or the switch), then a steady one.
 */
export async function scenarioE(stack, options, { out, save }) {
  const viewed = await pullRequestThread(stack, { slug: "bench/alpha", label: "e-open" });
  await pullRequestThread(stack, {
    slug: "bench/alpha",
    label: "e-merged",
    pr: { state: "MERGED", mergedAt: new Date(Date.now() - 1_800_000).toISOString() },
  });
  await pullRequestThread(stack, { slug: "bench/beta", label: "e-open" });
  await pullRequestThread(stack, {
    slug: "bench/beta",
    label: "e-closed",
    pr: { state: "CLOSED", closedAt: new Date(Date.now() - 1_800_000).toISOString() },
  });
  out.threads = 4;
  out.projects = 2;
  out.phases = [];
  const view = stack.mainView;
  const startupMs = options.startupMinutes * 60_000;
  const transitionMs = options.transitionMinutes * 60_000;
  const steadyMs = options.steadyMinutes * 60_000;
  for (const mode of ["focused", "blurred", "hidden"]) {
    // The clock starts before the page load (or the switch), so everything
    // they set off lands in the first window.
    const start = Date.now();
    const pageSaw =
      mode === "focused"
        ? (await view.openThread(viewed.threadId), null)
        : await view.setAttention(mode);
    const settleMs = mode === "focused" ? startupMs : transitionMs;
    console.log(
      `E ${mode}: first ${settleMs / 60_000} min, then ${options.steadyMinutes} min steady`,
    );
    await sleep(Math.max(0, start + settleMs - Date.now()));
    const steadyFrom = Date.now();
    await sleep(steadyMs);
    const end = Date.now();
    // Calls still running at the end answer within a second or two.
    await sleep(3_000);
    const calls = stack.readGhCalls();
    const fetches = stack
      .readGitRemoteCalls()
      .filter(
        (call) => call.service === "git-upload-pack" && call.t >= steadyFrom && call.t < end,
      ).length;
    // The windows are kept so the rates can be read again from the final log
    // (run.mjs does), which counts calls that were still running here.
    out.phases.push({
      mode,
      pageSaw,
      firstWindow: { from: start, to: steadyFrom },
      steadyWindow: { from: steadyFrom, to: end },
      [mode === "focused" ? "startup" : "transition"]: ghRate(calls, start, steadyFrom),
      steady: ghRate(calls, steadyFrom, end),
      fetchesPerMinute: Number((fetches / (steadyMs / 60_000)).toFixed(3)),
    });
    save();
    console.log(`E ${mode}`, JSON.stringify(out.phases.at(-1).steady));
  }
  await view.setAttention("focused");
}

/**
 * F: two repositories each have a pull request with the same number. Every
 * surface must show its own repository's one. A sample where a surface shows
 * a state its own pull request has not had by then is a wrong state.
 */
export async function scenarioF(stack, options, { out, save }) {
  out.runs = [];
  await stack.parkMainView();
  await eachRun(stack, options, async (index, view) => {
    const number = 7 + index;
    const alphaUrl = `https://github.com/bench/alpha/pull/${number}`;
    const betaUrl = `https://github.com/bench/beta/pull/${number}`;
    const alpha = await pullRequestThread(stack, {
      slug: "bench/alpha",
      label: "f",
      number,
      pr: { checks: "success" },
      say: `See ${alphaUrl} here and ${betaUrl} over there.`,
    });
    const beta = await pullRequestThread(stack, {
      slug: "bench/beta",
      label: "f",
      number,
      pr: { state: "CLOSED", closedAt: new Date().toISOString(), checks: "failure" },
    });
    await view.openThread(alpha.threadId);
    const onAlpha = [
      targetFor(alpha, { key: "alpha", composer: true }),
      targetFor(beta, { key: "beta", composer: false }),
    ];
    const onBeta = [
      targetFor(alpha, { key: "alpha", composer: false }),
      targetFor(beta, { key: "beta", composer: true }),
    ];
    // What each surface may show in each phase: every state its own pull
    // request has had up to then. Anything else came from the other one.
    const alphaOpen = {
      composer: ["open"],
      checks: ["success"],
      sidebar: ["open"],
      chip: ["open"],
    };
    const alphaMerged = {
      composer: ["open", "merged"],
      checks: ["success", "merged"],
      sidebar: ["open", "merged"],
      chip: ["open", "merged"],
    };
    const betaClosed = {
      composer: ["closed"],
      checks: ["closed"],
      sidebar: ["closed"],
      chip: ["closed"],
    };
    const betaReopened = {
      composer: ["closed", "open"],
      checks: ["closed", "failure"],
      sidebar: ["closed", "open"],
      chip: ["closed", "open"],
    };
    const phases = [
      { alpha: alphaOpen, beta: betaClosed },
      { alpha: alphaMerged, beta: betaClosed },
      { alpha: alphaMerged, beta: betaReopened },
    ];
    const wrong = [];
    const track = (phase, changes) => {
      for (const change of changes) {
        if (!change.surface || !("value" in change)) continue;
        const [key, surface] = change.surface.split(".");
        const allowed = phases[phase][key]?.[surface];
        if (
          allowed &&
          change.value !== null &&
          change.value !== "unknown" &&
          change.value !== "none" &&
          !allowed.includes(change.value)
        ) {
          wrong.push({ phase, ...change });
        }
      }
    };
    const record = { run: index + 1, number, flips: [], wrongStates: wrong };
    out.runs.push(record);
    const initial = await waitForSurfaces(view.page, {
      targets: onAlpha,
      expect: {
        "alpha.composer": "open",
        "alpha.checks": "success",
        "alpha.sidebar": "open",
        "alpha.chip": "open",
        "beta.sidebar": "closed",
        "beta.chip": "closed",
      },
      timeoutMs: 90_000,
    });
    track(0, initial.changes);
    record.initial = summarizeInitial(initial);
    await stack.waitForQuietGh({ maxMs: 30_000 });
    save();
    const merged = await timeFlip(stack, view, options, {
      thread: alpha,
      name: "open→merged",
      key: "alpha",
      surfaces: ALL_SURFACES,
      targets: onAlpha,
    });
    track(1, merged.changes);
    record.flips.push(merged);
    save();
    const reopened = await timeFlip(stack, view, options, {
      thread: beta,
      name: "closed→reopened",
      key: "beta",
      surfaces: ["sidebar", "chip"],
      targets: onAlpha,
    });
    track(2, reopened.changes);
    record.flips.push(reopened);
    save();
    // Each repository's composer row with the other's pull request of the same
    // number read before it: beta's thread, then alpha's again.
    await view.openThread(beta.threadId);
    const betaComposer = await waitForSurfaces(view.page, {
      targets: onBeta,
      expect: { "beta.composer": "open", "beta.checks": "failure" },
      timeoutMs: 90_000,
    });
    track(2, betaComposer.changes);
    record.betaComposer = summarizeInitial(betaComposer);
    await view.openThread(alpha.threadId);
    const alphaComposer = await waitForSurfaces(view.page, {
      targets: onAlpha,
      expect: { "alpha.composer": "merged", "alpha.checks": "merged" },
      timeoutMs: 90_000,
    });
    track(2, alphaComposer.changes);
    record.alphaComposerAgain = summarizeInitial(alphaComposer);
    save();
    console.log(
      `F run ${index + 1} #${number}: wrong states ${wrong.length}`,
      JSON.stringify(merged.lags),
      JSON.stringify(reopened.lags),
      `beta composer ${record.betaComposer.convergedS}s, alpha again ${record.alphaComposerAgain.convergedS}s`,
    );
    await stack.archiveThread(alpha.threadId);
    await stack.archiveThread(beta.threadId);
  });
}
