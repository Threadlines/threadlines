# Threadlines demo computer: the server built from this repo, a scripted ACP
# agent standing in for every real coding agent, and sample projects. It is
# what assistant-directory reviewers connect to (docs/design/assistants.md,
# "The demo computer"); see docker/demo/README.md.
#
# Build from the repository root:
#
#   docker build -f docker/demo/Dockerfile -t threadlines-demo .
#
# The published npm package is stable only, and stable lacks the assistants
# door, so the server is built from source here and installed the way npm
# would install it. Where the build machine is too small for the web bundle
# (Fly's remote builders run out of memory on it), pack the server on a
# bigger machine and install that instead (README, "Run it on Fly.io"):
#
#   docker build -f docker/demo/Dockerfile --build-arg SERVER_FROM=prebuilt ...
#
# with the package at docker/demo/prebuilt/threadlines-server-*.tgz.

ARG SERVER_FROM=source

# The server package, built here from the repository.
FROM node:24-bookworm AS server-source
WORKDIR /src
# Nothing in the build may carry an analytics key into the bundle.
ENV THREADLINES_TELEMETRY_ENABLED=false \
  ELECTRON_SKIP_BINARY_DOWNLOAD=1 \
  CI=true
RUN corepack enable
# Only what the build needs comes in (Dockerfile.dockerignore is an allowlist).
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm exec vp run --filter @threadlines/server build \
  && node scripts/prepare-server-npm-package.ts \
  && mkdir /tmp/pack \
  && cd release/npm-server \
  && npm pack --pack-destination /tmp/pack

# The server package, packed elsewhere the same way.
FROM node:24-bookworm AS server-prebuilt
COPY docker/demo/prebuilt/threadlines-server-*.tgz /tmp/pack/

FROM server-${SERVER_FROM} AS server-package

FROM node:24-bookworm AS build
COPY --from=server-package /tmp/pack /tmp/pack
# --allow-scripts: npm 11 skips install scripts otherwise, and node-pty
# builds its native part in one. The last step deletes the Claude Agent SDK's
# bundled Claude CLI (its optional per-platform package, about 320 MB): no
# provider runs here, and the SDK's own code loads without it. (npm 11 keeps
# it even with --omit=optional on a global install.)
RUN npm install -g --allow-scripts=node-pty --prefix /opt/threadlines /tmp/pack/*.tgz \
  && rm -rf /opt/threadlines/lib/node_modules/@threadlines/server/node_modules/@anthropic-ai/claude-agent-sdk-*

FROM node:24-bookworm-slim

LABEL org.opencontainers.image.source="https://github.com/Threadlines/threadlines" \
  org.opencontainers.image.description="Threadlines demo computer for assistant-directory reviewers: fake projects and a scripted agent, no real providers." \
  org.opencontainers.image.licenses="MIT"

# git for the sample repos and worktrees, curl for the health check, gh for
# the optional pull request sample (it reads GH_TOKEN), tini to reap the
# agent processes.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl git tini \
  && mkdir -p -m 755 /etc/apt/keyrings \
  && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
    -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
  && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
    > /etc/apt/sources.list.d/github-cli.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends gh \
  && rm -rf /var/lib/apt/lists/*

COPY --from=build /opt/threadlines /opt/threadlines
RUN ln -s /opt/threadlines/bin/threadlines /usr/local/bin/threadlines

# The scripted agent and the fixtures: plain Node, no dependencies.
COPY scripts/demo-computer/demo-agent.ts scripts/demo-computer/demo-fixtures.ts scripts/demo-computer/threadlinesClient.ts scripts/demo-computer/agentFolders.ts /opt/threadlines-demo/
COPY docker/demo/entrypoint.sh /usr/local/bin/threadlines-demo
RUN echo '{ "type": "module", "private": true }' > /opt/threadlines-demo/package.json \
  && chmod 755 /opt/threadlines-demo/demo-agent.ts /usr/local/bin/threadlines-demo

RUN userdel -r node \
  && useradd --create-home --uid 1000 --user-group threadlines

# No USER line: the entrypoint starts as root only to give the home folder to
# this user (a Fly.io volume is mounted owned by root), then runs everything,
# server and agents included, as `threadlines`. `docker exec` lands there too.
WORKDIR /home/threadlines

# No provider CLI is installed, and the settings the entrypoint writes turn
# every real provider off. The review flag only affects sign-ins the relay
# marks as review sign-ins (docs/design/assistants.md, "The reviewer's code").
ENV THREADLINES_HOME=/home/threadlines/.threadlines \
  THREADLINES_HOST=0.0.0.0 \
  THREADLINES_PORT=3773 \
  THREADLINES_MODE=web \
  THREADLINES_NO_BROWSER=1 \
  THREADLINES_AUTO_BOOTSTRAP_PROJECT_FROM_CWD=false \
  THREADLINES_TELEMETRY_ENABLED=false \
  THREADLINES_ASSISTANT_REVIEW_COMPUTER=1 \
  DEMO_REPOS_DIR=/home/threadlines/demo-repos \
  DEMO_AGENT_RUN_DIR=/tmp/threadlines-demo-agents

EXPOSE 3773

# -g: a stop signal reaches the server and the agents it started too.
ENTRYPOINT ["tini", "-g", "--", "threadlines-demo"]
CMD ["serve"]

# Healthy means the server answers and the last reset of the fake data
# succeeded: a container whose fixtures failed reports itself unhealthy.
HEALTHCHECK --interval=30s --timeout=5s --start-period=90s \
  CMD curl -fsS "http://127.0.0.1:${THREADLINES_PORT}/api/auth/session" >/dev/null \
    && threadlines-demo ready || exit 1
