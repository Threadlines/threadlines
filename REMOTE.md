# Device Access

Threadlines is local-first: your desktop computer still runs the projects and
provider CLIs. The device-access work is for reaching that desktop from another
device, most commonly a phone or tablet.

The public hosted link for this flow is `https://app.threadlines.dev`. It can
open a one-time device link and route the phone or tablet to the desktop
Threadlines instance when the desktop is reachable.

The planned public-friendly path is the Cloudflare relay in
`apps/relay-worker`. See `docs/cloudflare-relay.md` for setup and deployment
notes.

Current product wording should lead with user concepts:

- phone and tablet access for the main setup path;
- private network link for Tailscale-backed access;
- another computer for remote Threadlines instances;
- SSH only as an advanced setup path.

Do not use old T3-hosted domains for new setup. Existing internal protocol names
and package names may remain for compatibility until they can be changed safely.

## The in-app browser across computers

When an agent on another computer uses the browser, it opens on the computer
the user is at: the one with the most recent keyboard or mouse input among
those connected. It moves there from a computer nobody is using, never in the
middle of an action (`PreviewAutomationBroker.ts`).

Pages in that browser reach the agent's `localhost`, not this computer's. Each
loopback connection goes through a small proxy in the desktop app, then over
the connection the app already holds, and the agent's server opens it on its
own loopback (`packages/contracts/src/previewTunnel.ts`,
`apps/desktop/src/preview/PreviewLoopbackProxy.ts`). Everything else loads
from this computer as usual.

Limits: the tunnel is refused over the relay, which counts every message
against a daily allowance, so `localhost` there works on the same network or
over Tailscale. Those pages also skip a system proxy set on this computer for
public sites.
