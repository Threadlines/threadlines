import type { EnvironmentId } from "@threadlines/contracts";
import { FolderIcon } from "lucide-react";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { environmentUsesRelayTransport, resolveEnvironmentHttpUrl } from "../environments/runtime";
import { projectFaviconQueryOptions } from "../lib/projectReactQuery";

const PROJECT_FAVICON_RESOLVER_VERSION = "3";
const loadedProjectFaviconSrcs = new Set<string>();

export function ProjectFavicon(input: {
  environmentId: EnvironmentId;
  cwd: string;
  className?: string;
}) {
  // Relay-paired environments (phonelink) can't reach the favicon HTTP
  // route — the relay carries only the WebSocket — so fetch the icon bytes
  // over RPC and render them as a data URL instead.
  const usesRelay = environmentUsesRelayTransport(input.environmentId);
  const faviconQuery = useQuery(
    projectFaviconQueryOptions({
      environmentId: input.environmentId,
      cwd: input.cwd,
      enabled: usesRelay,
    }),
  );

  const src = (() => {
    if (usesRelay) {
      return faviconQuery.data ?? null;
    }
    try {
      return resolveEnvironmentHttpUrl({
        environmentId: input.environmentId,
        pathname: "/api/project-favicon",
        searchParams: { cwd: input.cwd, v: PROJECT_FAVICON_RESOLVER_VERSION },
      });
    } catch {
      return null;
    }
  })();
  const [status, setStatus] = useState<"loading" | "loaded" | "error">(() =>
    src && loadedProjectFaviconSrcs.has(src) ? "loaded" : "loading",
  );
  // Data URLs carry their bytes inline, so skip the load-tracking dance the
  // HTTP path needs to avoid flashing the fallback while the request runs.
  const isLoaded =
    src !== null && ((src.startsWith("data:") && status !== "error") || status === "loaded");

  if (!src) {
    return (
      <FolderIcon
        className={`size-3.5 shrink-0 text-muted-foreground/50 ${input.className ?? ""}`}
      />
    );
  }

  return (
    <>
      {!isLoaded ? (
        <FolderIcon
          className={`size-3.5 shrink-0 text-muted-foreground/50 ${input.className ?? ""}`}
        />
      ) : null}
      <img
        src={src}
        alt=""
        className={`size-3.5 shrink-0 rounded-sm object-contain ${isLoaded ? "" : "hidden"} ${input.className ?? ""}`}
        onLoad={() => {
          loadedProjectFaviconSrcs.add(src);
          setStatus("loaded");
        }}
        onError={() => setStatus("error")}
      />
    </>
  );
}
