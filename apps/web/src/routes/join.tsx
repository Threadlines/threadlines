import { createFileRoute, redirect } from "@tanstack/react-router";

import { HostedJoinRouteSurface } from "../components/auth/HostedJoinRouteSurface";

/** QR landing for "Connect a device" (hosted app). See HostedJoinRouteSurface. */
export const Route = createFileRoute("/join")({
  beforeLoad: ({ context }) => {
    if (context.authGateState.status !== "hosted-pairing") {
      throw redirect({ to: "/", replace: true });
    }
    return { authGateState: context.authGateState };
  },
  component: HostedJoinRouteSurface,
});
