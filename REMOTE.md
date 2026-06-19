# Device Access

Threadlines is local-first: your desktop computer still runs the projects and
provider CLIs. The device-access work is for reaching that desktop from another
device, most commonly a phone or tablet.

The public hosted link for this flow is `https://app.threadlines.dev`. It can
open a one-time device link and route the phone or tablet to the desktop
Threadlines instance when the desktop is reachable.

Current product wording should lead with user concepts:

- phone and tablet access for the main setup path;
- private network link for Tailscale-backed access;
- another computer for remote Threadlines instances;
- SSH only as an advanced setup path.

Do not use old T3-hosted domains for new setup. Existing internal protocol names
and package names may remain for compatibility until they can be changed safely.
