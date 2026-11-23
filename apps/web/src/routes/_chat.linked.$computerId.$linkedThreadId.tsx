import { createFileRoute } from "@tanstack/react-router";

import { LinkedThreadView } from "../components/chat/LinkedThreadView";
import { resolveLinkedThreadRouteRef } from "../environments/links/linkedThreads";

/** A child on a computer this app can't see, read through the link (LinkedThreadView). */
function LinkedThreadRoute() {
  const childRef = resolveLinkedThreadRouteRef(Route.useParams());
  if (childRef === null) return null;
  return (
    <LinkedThreadView key={`${childRef.environmentId}:${childRef.threadId}`} childRef={childRef} />
  );
}

export const Route = createFileRoute("/_chat/linked/$computerId/$linkedThreadId")({
  component: LinkedThreadRoute,
});
