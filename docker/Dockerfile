# Threadlines self-host image: the published npm server plus the provider CLIs
# it drives, ready to run as a long-lived service on a VPS or homelab box.
#
#   docker run -d --name threadlines --restart unless-stopped \
#     -p 3773:3773 \
#     -v threadlines-home:/home/threadlines \
#     -v /path/to/your/repos:/workspace \
#     ghcr.io/threadlines/threadlines:latest
#
# First run: `docker logs threadlines` prints the pairing link that unlocks
# the web app and mints phone pairing QR codes (Settings -> Devices).

ARG THREADLINES_VERSION=latest

# node-pty compiles natively on install, so the install happens in a stage
# with a toolchain and only the result ships.
FROM node:22-bookworm AS build
ARG THREADLINES_VERSION
RUN npm install -g --prefix /opt/threadlines "@threadlines/server@${THREADLINES_VERSION}"

FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    git \
    openssh-client \
    tini \
  && rm -rf /var/lib/apt/lists/*

# The coding agent CLIs the server orchestrates. Their credentials land in
# the home volume, so sign-ins survive container replacement.
RUN npm install -g @anthropic-ai/claude-code @openai/codex

COPY --from=build /opt/threadlines /opt/threadlines
RUN ln -s /opt/threadlines/bin/threadlines /usr/local/bin/threadlines

# Reuse uid/gid 1000 (the image's `node` user) so named volumes and typical
# bind mounts agree on ownership.
RUN userdel -r node \
  && useradd --create-home --uid 1000 --user-group threadlines \
  && mkdir -p /workspace \
  && chown threadlines:threadlines /workspace

USER threadlines
WORKDIR /workspace

# Bind-mounted repos rarely share the container user's uid; without this git
# refuses them as "dubious ownership". /workspace is the operator's own code.
RUN git config --global safe.directory "*"

ENV THREADLINES_HOME=/home/threadlines/.threadlines \
  THREADLINES_HOST=0.0.0.0 \
  THREADLINES_PORT=3773 \
  THREADLINES_NO_BROWSER=1 \
  # A service must not mint a project from its own working directory the way
  # a `npx` launch does; operators add projects from /workspace deliberately.
  THREADLINES_AUTO_BOOTSTRAP_PROJECT_FROM_CWD=false

EXPOSE 3773

# Agent sessions spawn deep process trees; tini reaps what they leave behind.
ENTRYPOINT ["tini", "--", "threadlines"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s \
  CMD curl -fsS "http://127.0.0.1:${THREADLINES_PORT}/api/auth/session" || exit 1
