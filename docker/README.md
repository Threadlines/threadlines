# Threadlines on a server

Run Threadlines on a machine that is always on: a VPS, a home server, or a
spare computer. Your coding agents keep working when your laptop is closed,
and your phone or any browser connects to them from anywhere.

## Quick start

```bash
docker run -d --name threadlines --restart unless-stopped \
  -p 3773:3773 \
  -v threadlines-home:/home/threadlines \
  -v /path/to/your/repos:/workspace \
  ghcr.io/threadlines/threadlines:latest
```

Then:

```bash
docker logs threadlines
```

The log prints a one-time link. Open it in a browser to unlock the web app.
From there, Settings -> Devices mints QR codes for pairing your phone.

That is the whole install.

## What the pieces mean

- `--restart unless-stopped` makes Docker bring Threadlines back after a
  crash or a server reboot. Nothing to babysit.
- `threadlines-home` is a named volume holding everything that must survive:
  your threads, settings, device pairings, and the Claude/Codex sign-ins.
  Containers are disposable; this volume is not.
- `/workspace` is where your repositories live. Mount the folder that holds
  them and add projects from `/workspace/...` inside the app.
- Port `3773` serves both the web app and the phone connection.

If clients will reach the server at a known address, tell startup links about
it with `-e THREADLINES_ADVERTISED_HOST=your-server.example.com` so the URL
in `docker logs` is directly clickable.

## Signing in to the agents

The Claude Code and Codex CLIs ship inside the image. Sign in once from the
web app (Settings -> Providers); the credentials land in the home volume and
survive container updates. For Claude on a headless server, the
"Advanced: headless chat token" flow in provider settings avoids needing a
browser on the server itself.

## Updating

```bash
docker pull ghcr.io/threadlines/threadlines:latest
docker rm -f threadlines
# re-run the same docker run command
```

Your data lives in the volume, so this is safe. Pin a version tag
(for example `ghcr.io/threadlines/threadlines:0.3.3`) if you prefer
updates on your own schedule.

## Reaching it from outside your network

The safest defaults, in order of effort:

- **Tailscale or a VPN**: install it on the server and your devices, then use
  the server's private address. Nothing is exposed to the internet.
- **A reverse proxy with HTTPS** (Caddy, nginx, Traefik) in front of port
  3773, if you want a public address. Threadlines requires pairing before any
  data is served, but public endpoints deserve TLS.

Avoid exposing port 3773 to the open internet without one of the above.

## docker-compose

```yaml
services:
  threadlines:
    image: ghcr.io/threadlines/threadlines:latest
    container_name: threadlines
    restart: unless-stopped
    ports:
      - "3773:3773"
    volumes:
      - threadlines-home:/home/threadlines
      - /path/to/your/repos:/workspace

volumes:
  threadlines-home:
```
