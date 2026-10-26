// The throwaway stack the GitHub status benchmark runs against: scratch git
// repositories that look like GitHub, a fake `gh` and a fake fx agent on the
// server's PATH, one Threadlines server from source serving the production web
// build, and one headless browser paired with it. Nothing here touches
// ~/.threadlines or starts a real provider.
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { chromium } from "playwright";

export const BENCH_DIR = import.meta.dirname;
export const REPO_ROOT = path.resolve(BENCH_DIR, "../../../..");
const SERVER_DIR = path.join(REPO_ROOT, "apps/server");
const WEB_DIST = path.join(REPO_ROOT, "apps/web/dist");

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export const uuid = () => crypto.randomUUID();
export const nowIso = () => new Date().toISOString();

const PROVIDERS_OFF = [
  "codex",
  "claudeAgent",
  "cursor",
  "opencode",
  "antigravity",
  "muse",
  "grok",
  "pi",
];

/**
 * Builds the scratch folder, the fake tools and the settings, then starts the
 * server and the browser. `close()` stops exactly the processes it started.
 */
export async function createStack(options) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "tl-ghbench."));
  const stack = new Stack(root, options);
  stack.prepare();
  return stack;
}

class Stack {
  constructor(root, options) {
    this.root = root;
    this.options = options;
    this.port = options.port;
    this.baseUrl = `http://127.0.0.1:${this.port}`;
    this.home = path.join(root, "home");
    this.binDir = path.join(root, "bin");
    this.ghStatePath = path.join(root, "gh-state.json");
    this.ghLogPath = path.join(root, "gh-calls.jsonl");
    this.gitRemoteLogPath = path.join(root, "git-remote.jsonl");
    this.serverLogPath = path.join(root, "server.log");
    this.gitConfigPath = path.join(root, "gitconfig");
    // Nothing inherited may steer git or gh elsewhere: an exported
    // GIT_SSH_COMMAND would beat the checkouts' fake ssh, and the real gh's
    // settings have no business here.
    const inherited = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !/^(GIT_|GH_|GITHUB_)/u.test(key)),
    );
    this.gitEnv = {
      ...inherited,
      GIT_CONFIG_GLOBAL: this.gitConfigPath,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
    };
    this.ghState = { viewer: "bench-user", repos: {} };
    this.repos = new Map();
    this.server = null;
    this.browser = null;
    this.context = null;
    this.page = null;
    this.environmentId = null;
    this.db = null;
  }

  prepare() {
    for (const dir of [this.home, this.binDir, "remotes", "projects", "peers", "worktrees"]) {
      fs.mkdirSync(path.isAbsolute(dir) ? dir : path.join(this.root, dir), { recursive: true });
    }
    fs.writeFileSync(
      this.gitConfigPath,
      [
        "[user]",
        "\tname = Bench User",
        "\temail = bench@example.invalid",
        "[init]",
        "\tdefaultBranch = main",
        "[advice]",
        "\tdetachedHead = false",
        "",
      ].join("\n"),
    );
    const node = process.execPath;
    const wrapper = (script, env) =>
      [
        "#!/bin/sh",
        ...Object.entries(env).map(([key, value]) => `export ${key}='${value}'`),
        `exec '${node}' '${path.join(BENCH_DIR, script)}' "$@"`,
        "",
      ].join("\n");
    fs.writeFileSync(
      path.join(this.binDir, "gh"),
      wrapper("fake-gh.mjs", {
        FAKE_GH_STATE: this.ghStatePath,
        FAKE_GH_LOG: this.ghLogPath,
        FAKE_GH_LATENCY_MS: String(this.options.latencyMs),
      }),
      { mode: 0o755 },
    );
    fs.writeFileSync(path.join(this.binDir, "fx"), wrapper("fake-fx.mjs", {}), { mode: 0o755 });
    // Checkouts reach "github.com" over ssh, and this is their ssh: it serves
    // the git request from the local bare repository of the same name, and
    // notes when each one starts and finishes. (An https remote rewritten with
    // `insteadOf` would show git's rewritten path to the server, which then
    // would not see GitHub.)
    const now = `$(perl -MTime::HiRes=time -e 'printf("%d", time() * 1000)')`;
    fs.writeFileSync(
      path.join(this.binDir, "fake-ssh"),
      [
        "#!/bin/sh",
        "for last; do :; done",
        'service="${last%% *}"',
        'repo=$(printf \'%s\' "${last#* }" | tr -d "\'")',
        'name=$(basename "$repo" .git)',
        `started="${now}"`,
        `git "\${service#git-}" '${path.join(this.root, "remotes")}'/"$name".git`,
        "code=$?",
        `printf '{"t":%s,"end":%s,"exit":%s,"service":"%s","repo":"%s","cwd":"%s"}\\n' "$started" "${now}" "$code" "$service" "$name" "$PWD" >> '${this.gitRemoteLogPath}'`,
        'exit "$code"',
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    // Any other ssh (the server's own sign-in probe sets GIT_SSH_COMMAND to
    // plain `ssh`) is refused rather than allowed to reach github.com.
    fs.writeFileSync(
      path.join(this.binDir, "ssh"),
      [
        "#!/bin/sh",
        `printf '{"t":%s,"service":"refused-ssh","args":"%s"}\\n' "$(perl -MTime::HiRes=time -e 'printf("%d", time() * 1000)')" "$*" >> '${this.gitRemoteLogPath}'`,
        'echo "benchmark: ssh is disabled here" >&2',
        "exit 255",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    // The server reads PATH from the user's login shell at startup and puts
    // that first, which would find the real `gh` before the fake one. This
    // "login shell" runs the probe with no profile, so it reports the PATH
    // the benchmark set.
    fs.writeFileSync(
      path.join(this.binDir, "login-shell"),
      [
        "#!/bin/sh",
        'if [ "$1" = "-ilc" ]; then exec /bin/sh -c "$2"; fi',
        'exec /bin/sh "$@"',
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    this.saveGhState();
    const settingsDir = path.join(this.home, "userdata");
    fs.mkdirSync(settingsDir, { recursive: true });
    fs.writeFileSync(
      path.join(settingsDir, "settings.json"),
      JSON.stringify({
        providers: {
          ...Object.fromEntries(PROVIDERS_OFF.map((id) => [id, { enabled: false }])),
          fx: { enabled: true, binaryPath: path.join(this.binDir, "fx") },
        },
      }),
    );
  }

  git(cwd, ...args) {
    return execFileSync("git", args, {
      cwd,
      env: this.gitEnv,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  }

  /** Writes the fake GitHub's state in one rename, so `gh` never reads half a file. */
  saveGhState() {
    const temp = `${this.ghStatePath}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(this.ghState, null, 2));
    fs.renameSync(temp, this.ghStatePath);
  }

  /**
   * A repository "on GitHub": a local bare repository standing in for the
   * remote, a checkout whose origin is the github.com ssh address (its ssh is
   * the fake one, which serves the bare repository), and a peer clone that
   * pushes to it as somebody else would.
   */
  addRepo(slug) {
    const name = slug.split("/")[1];
    const bare = path.join(this.root, "remotes", `${name}.git`);
    const checkout = path.join(this.root, "projects", name);
    const peer = path.join(this.root, "peers", name);
    const remoteUrl = `git@github.com:${slug}.git`;
    this.git(this.root, "init", "--bare", "-b", "main", bare);
    this.git(this.root, "init", "-b", "main", checkout);
    fs.writeFileSync(path.join(checkout, "README.md"), `# ${slug}\n`);
    this.git(checkout, "add", "README.md");
    this.git(checkout, "commit", "-m", "Initial commit");
    this.git(checkout, "remote", "add", "origin", remoteUrl);
    this.git(checkout, "config", "core.sshCommand", path.join(this.binDir, "fake-ssh"));
    this.git(checkout, "config", "ssh.variant", "simple");
    this.git(checkout, "push", "-u", "origin", "main");
    this.git(checkout, "remote", "set-head", "origin", "main");
    this.git(this.root, "clone", bare, peer);
    const repo = { slug, name, bare, checkout, peer, remoteUrl, peerCommits: 0 };
    this.repos.set(slug, repo);
    this.ghState.repos[slug] = { defaultBranch: "main", pulls: [] };
    this.saveGhState();
    return repo;
  }

  /** `count` commits on the remote's main from the peer clone; returns the remote's head. */
  peerPush(slug, count) {
    const repo = this.repos.get(slug);
    this.git(repo.peer, "pull", "--ff-only", "origin", "main");
    for (let index = 0; index < count; index += 1) {
      repo.peerCommits += 1;
      fs.writeFileSync(
        path.join(repo.peer, `peer-${repo.peerCommits}.txt`),
        `${repo.peerCommits}\n`,
      );
      this.git(repo.peer, "add", ".");
      this.git(repo.peer, "commit", "-m", `Peer commit ${repo.peerCommits}`);
    }
    this.git(repo.peer, "push", "origin", "main");
    return this.git(repo.peer, "rev-parse", "HEAD");
  }

  /** A branch in its own worktree, pushed, so a thread can sit on it. */
  addBranch(slug, branch) {
    const repo = this.repos.get(slug);
    const worktree = path.join(
      this.root,
      "worktrees",
      `${repo.name}-${branch.replace(/[^\w.-]+/gu, "-")}`,
    );
    this.git(repo.checkout, "worktree", "add", "-b", branch, worktree, "main");
    fs.writeFileSync(
      path.join(worktree, `${branch.replace(/[^\w.-]+/gu, "-")}.txt`),
      `${branch}\n`,
    );
    this.git(worktree, "add", ".");
    this.git(worktree, "commit", "-m", `Work on ${branch}`);
    this.git(worktree, "push", "-u", "origin", branch);
    return { worktree, headSha: this.git(worktree, "rev-parse", "HEAD") };
  }

  /** Adds a pull request to the fake GitHub. Dated an hour back, before any thread. */
  addPullRequest(slug, pr) {
    const created = new Date(Date.now() - 3_600_000).toISOString();
    const record = {
      state: "OPEN",
      isDraft: false,
      checks: "success",
      baseRefName: "main",
      additions: 12,
      deletions: 3,
      createdAt: created,
      updatedAt: created,
      ...pr,
    };
    this.ghState.repos[slug].pulls.push(record);
    this.saveGhState();
    return record;
  }

  pullRequest(slug, number) {
    const pr = this.ghState.repos[slug].pulls.find((entry) => entry.number === number);
    if (!pr) throw new Error(`no pull request ${slug}#${number}`);
    return pr;
  }

  /** Changes a pull request on the fake GitHub; returns the moment it changed. */
  flip(slug, number, change) {
    const pr = this.pullRequest(slug, number);
    const at = Date.now();
    const iso = new Date(at).toISOString();
    change(pr, iso);
    pr.updatedAt = iso;
    this.saveGhState();
    return at;
  }

  /**
   * Every `gh` call, by start time: the answered ones with their kind, and any
   * that never answered (still running, or killed) as kind "unfinished".
   */
  readGhCalls() {
    const lines = readJsonLines(this.ghLogPath);
    const ended = new Set(lines.filter((line) => line.phase === "end").map((line) => line.id));
    return lines
      .filter((line) => line.phase === "end" || !ended.has(line.id))
      .map((line) =>
        line.phase === "end" ? line : { ...line, kind: "unfinished", exit: null, durMs: null },
      )
      .toSorted((a, b) => a.t - b.t);
  }

  /**
   * Waits until no `gh` call is running and none has answered for `idleMs`
   * (and at least `minMs` has passed), so a change is not timed against reads
   * a page load or an earlier change already had in flight. A call silent for
   * a minute counts as dead. Gives up after `maxMs`; returns whether it was quiet.
   */
  async waitForQuietGh({ idleMs = 5_000, minMs = 5_000, maxMs = 60_000 } = {}) {
    const start = Date.now();
    while (Date.now() - start < maxMs) {
      await sleep(500);
      const now = Date.now();
      const calls = this.readGhCalls();
      const running = calls.some((call) => call.kind === "unfinished" && now - call.t < 60_000);
      const lastEnd = Math.max(0, ...calls.map((call) => call.t + (call.durMs ?? 0)));
      if (now - start >= minMs && !running && now - lastEnd >= idleMs) return true;
    }
    return false;
  }

  /** Fetches and pushes that reached the fake "github.com" over ssh. */
  readGitRemoteCalls() {
    return readJsonLines(this.gitRemoteLogPath);
  }

  async startServer() {
    if (!fs.existsSync(path.join(WEB_DIST, "index.html"))) {
      throw new Error(`No web build at ${WEB_DIST}. Run \`vp build\` in apps/web first.`);
    }
    const log = fs.openSync(this.serverLogPath, "a");
    const env = {
      ...this.gitEnv,
      PATH: `${this.binDir}:${process.env.PATH}`,
      SHELL: path.join(this.binDir, "login-shell"),
      THREADLINES_HOME: this.home,
      THREADLINES_PORT: String(this.port),
      THREADLINES_NO_BROWSER: "1",
      THREADLINES_MODE: "web",
      THREADLINES_TELEMETRY_ENABLED: "false",
      THREADLINES_AUTO_BOOTSTRAP_PROJECT_FROM_CWD: "false",
    };
    delete env.VITE_DEV_SERVER_URL;
    delete env.ELECTRON_RUN_AS_NODE;
    // What the server's PATH probe will see; it must find the fake gh.
    const resolvedGh = execFileSync(env.SHELL, ["-ilc", "command -v gh"], {
      env,
      encoding: "utf8",
    }).trim();
    if (resolvedGh !== path.join(this.binDir, "gh")) {
      throw new Error(`gh resolves to ${resolvedGh}, not the fake one; refusing to start.`);
    }
    // Its own process group, so stopping it also stops the agents it started.
    this.server = spawn(process.execPath, ["src/bin.ts"], {
      cwd: SERVER_DIR,
      env,
      detached: true,
      stdio: ["ignore", log, log],
    });
    this.serverExited = new Promise((resolve) => this.server.once("exit", resolve));
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      const text = fs.readFileSync(this.serverLogPath, "utf8");
      const token = /pairingUrl: \S+#token=(\w+)/u.exec(text)?.[1];
      if (token) {
        this.pairingToken = token;
        return;
      }
      if (this.server.exitCode !== null) break;
      await sleep(300);
    }
    throw new Error(`The server did not start; see ${this.serverLogPath}`);
  }

  /**
   * The server probes `gh` once a page connects. Unless that probe reached the
   * fake one, the real CLI (and the real account) would be answering: stop
   * before anything else asks it.
   */
  async requireFakeGh() {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (
        this.readGhCalls().some((call) => call.kind === "version" || call.kind === "auth-status")
      ) {
        return;
      }
      await sleep(250);
    }
    await this.close();
    throw new Error(
      "The server never ran the fake gh; refusing to go on with the real one on PATH.",
    );
  }

  async openBrowser() {
    // Full headless Chromium rather than the headless shell: only it answers
    // focus emulation with a real window blur.
    this.browser = await chromium.launch({ headless: true, channel: "chromium" });
    this.context = await this.browser.newContext({
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 1,
    });
    await this.context.addInitScript(installAttentionControls);
    this.mainView = await this.newView();
    this.page = this.mainView.page;
    await this.page.goto(`${this.baseUrl}/pair#token=${this.pairingToken}`);
    await this.page.waitForURL((url) => !url.pathname.startsWith("/pair"), { timeout: 30_000 });
    await sleep(1500);
    const setupLater = this.page.getByText("Set up later");
    if (await setupLater.count()) {
      await setupLater.first().click();
      await sleep(1000);
    }
    const environment = await (
      await fetch(`${this.baseUrl}/.well-known/threadlines/environment`)
    ).json();
    this.environmentId = environment.environmentId;
    this.db = new DatabaseSync(path.join(this.home, "userdata", "state.sqlite"), {
      readOnly: true,
    });
    await this.requireFakeGh();
  }

  async dispatch(command) {
    const result = await this.page.evaluate(async (body) => {
      const response = await fetch("/api/orchestration/dispatch", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      return { status: response.status, text: await response.text() };
    }, command);
    if (result.status !== 200) {
      throw new Error(`dispatch ${command.type} failed: ${result.status} ${result.text}`);
    }
  }

  async projects() {
    return this.page.evaluate(async () => {
      const response = await fetch("/api/orchestration/projects", { credentials: "include" });
      return (await response.json()).projects;
    });
  }

  /** A project on the repository's checkout, once the page knows its GitHub name. */
  async createProject(slug) {
    const repo = this.repos.get(slug);
    const projectId = uuid();
    await this.dispatch({
      type: "project.create",
      commandId: uuid(),
      projectId,
      title: repo.name,
      workspaceRoot: repo.checkout,
      createdAt: nowIso(),
    });
    repo.projectId = projectId;
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if ((await this.projects()).some((entry) => entry.id === projectId)) return projectId;
      await sleep(300);
    }
    throw new Error(`project ${slug} was never created`);
  }

  async createThread({ slug, title, branch = null, worktreePath = null }) {
    const threadId = uuid();
    await this.dispatch({
      type: "thread.create",
      commandId: uuid(),
      threadId,
      projectId: this.repos.get(slug).projectId,
      title,
      modelSelection: { instanceId: "fx", model: "fake-model" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch,
      worktreePath,
      createdAt: nowIso(),
    });
    return threadId;
  }

  /** One fx turn whose reply is exactly `text`. Waits for the reply to land. */
  async agentSays(threadId, text) {
    await this.dispatch({
      type: "thread.turn.start",
      commandId: uuid(),
      threadId,
      message: {
        messageId: uuid(),
        role: "user",
        text: `Report back. SAY64:${Buffer.from(text).toString("base64")}`,
        attachments: [],
      },
      modelSelection: { instanceId: "fx", model: "fake-model" },
      runtimeMode: "full-access",
      interactionMode: "default",
      createdAt: nowIso(),
    });
    const query = this.db.prepare(
      "select count(*) as n from projection_thread_messages where thread_id = ? and role = 'assistant' and is_streaming = 0",
    );
    const sessionQuery = this.db.prepare(
      "select status from projection_thread_sessions where thread_id = ?",
    );
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      if (query.get(threadId).n > 0 && sessionQuery.get(threadId)?.status !== "running") return;
      await sleep(300);
    }
    throw new Error(`the agent never replied in thread ${threadId}`);
  }

  async archiveThread(threadId) {
    await this.dispatch({ type: "thread.archive", commandId: uuid(), threadId });
  }

  /**
   * Another tab in the same browser: a client of its own (its own socket and
   * caches), so runs of a scenario can go side by side, each on its thread.
   */
  async newView() {
    const page = await this.context.newPage();
    page.on("pageerror", (error) => console.log("[pageerror]", error.message));
    const cdp = await this.context.newCDPSession(page);
    return new View(this, page, cdp);
  }

  /**
   * Leaves the first tab on a page of the server's with no app in it, so it is
   * not one more client while runs go side by side. Dispatch still works there.
   */
  async parkMainView() {
    await this.page.goto(`${this.baseUrl}/.well-known/threadlines/environment`);
  }

  /** A blank tab that takes the browser's real focus while a view is "away". */
  focusSink() {
    this.focusSinkPage ??= this.context.newPage();
    return this.focusSinkPage;
  }

  openThread(threadId) {
    return this.mainView.openThread(threadId);
  }

  setAttention(mode) {
    return this.mainView.setAttention(mode);
  }

  async close() {
    try {
      await this.browser?.close();
    } catch {}
    try {
      this.db?.close();
    } catch {}
    if (this.server && this.server.exitCode === null) {
      try {
        process.kill(-this.server.pid, "SIGTERM");
      } catch {}
      const exited = await Promise.race([this.serverExited.then(() => true), sleep(15_000)]);
      if (!exited) {
        try {
          process.kill(-this.server.pid, "SIGKILL");
        } catch {}
      }
    }
  }
}

/** One tab: where a scenario run looks, and whose attention it moves. */
class View {
  constructor(stack, page, cdp) {
    this.stack = stack;
    this.page = page;
    this.cdp = cdp;
  }

  async openThread(threadId) {
    await this.page.goto(`${this.stack.baseUrl}/${this.stack.environmentId}/${threadId}`);
    await this.page.waitForSelector('[data-testid^="thread-row-"], [data-testid^="done-row-"]', {
      timeout: 30_000,
    });
  }

  /**
   * Who has the window's attention: "focused", "blurred" (visible, another
   * window has focus) or "hidden" (minimised or another tab). Blur is the
   * browser's own focus emulation. Hidden cannot be produced in headless
   * Chromium, so the page is told it is hidden the way a hidden tab is:
   * `document.visibilityState` and a `visibilitychange` event. Timers are not
   * throttled the way a real hidden tab's are.
   */
  async setAttention(mode) {
    // Real focus goes to a blank tab first, so turning emulation off really
    // leaves this one unfocused (every tab is its own window here).
    if (mode === "focused") await this.page.bringToFront();
    else await (await this.stack.focusSink()).bringToFront();
    await this.cdp.send("Emulation.setFocusEmulationEnabled", { enabled: mode === "focused" });
    await this.page.evaluate((next) => window.__benchAttention.set(next), mode);
    await sleep(200);
    // What the page now believes, recorded so a run shows the switch took.
    return this.page.evaluate(() => ({
      hasFocus: document.hasFocus(),
      visibilityState: document.visibilityState,
    }));
  }

  async close() {
    await this.page.close().catch(() => undefined);
  }
}

/**
 * Runs in the page before the app. `hidden` overrides what the page reads as
 * its visibility; focus comes from the browser's focus emulation.
 */
function installAttentionControls() {
  let hidden = false;
  const visibility = Object.getOwnPropertyDescriptor(Document.prototype, "visibilityState");
  const hiddenFlag = Object.getOwnPropertyDescriptor(Document.prototype, "hidden");
  Object.defineProperty(Document.prototype, "visibilityState", {
    configurable: true,
    get() {
      return hidden ? "hidden" : visibility.get.call(this);
    },
  });
  Object.defineProperty(Document.prototype, "hidden", {
    configurable: true,
    get() {
      return hidden || hiddenFlag.get.call(this);
    },
  });
  window.__benchAttention = {
    set(mode) {
      const nextHidden = mode === "hidden";
      if (nextHidden !== hidden) {
        hidden = nextHidden;
        // It bubbles like the browser's own: TanStack Query listens on window.
        document.dispatchEvent(new Event("visibilitychange", { bubbles: true }));
      }
    },
  };
}

function readJsonLines(file) {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

/** Percentile over a list of numbers, nearest rank; null for an empty list. */
export function percentile(values, p) {
  const sorted = values.filter((value) => Number.isFinite(value)).toSorted((a, b) => a - b);
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
}

/** `gh` calls in [from, to), per minute and by kind. */
export function ghRate(calls, from, to) {
  const minutes = (to - from) / 60_000;
  const byKind = {};
  let total = 0;
  for (const call of calls) {
    if (call.t < from || call.t >= to) continue;
    byKind[call.kind] = (byKind[call.kind] ?? 0) + 1;
    total += 1;
  }
  const perMinute = Object.fromEntries(
    Object.entries(byKind)
      .toSorted((a, b) => b[1] - a[1])
      .map(([kind, count]) => [kind, Number((count / minutes).toFixed(3))]),
  );
  return {
    minutes: Number(minutes.toFixed(2)),
    total,
    perMinute,
    totalPerMinute: Number((total / minutes).toFixed(3)),
  };
}
