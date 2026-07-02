import { createElement } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRouter, RouterHistory } from "@tanstack/react-router";

import { AppAtomRegistryProvider } from "./rpc/atomRegistry";
import { routeTree } from "./routeTree.gen";

export function getRouter(history: RouterHistory) {
  const queryClient = new QueryClient();

  // Console preview tools for the updater surfaces; the dynamic import keeps
  // them out of production bundles entirely.
  if (import.meta.env.DEV && import.meta.env.MODE !== "test" && typeof window !== "undefined") {
    void import("./dev/updatePreviewDevTools").then((devTools) =>
      devTools.installUpdatePreviewDevTools(queryClient),
    );
  }

  return createRouter({
    routeTree,
    history,
    context: {
      queryClient,
    },
    Wrap: ({ children }) =>
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(AppAtomRegistryProvider, undefined, children),
      ),
  });
}

export type AppRouter = ReturnType<typeof getRouter>;

declare module "@tanstack/react-router" {
  interface Register {
    router: AppRouter;
  }
}
