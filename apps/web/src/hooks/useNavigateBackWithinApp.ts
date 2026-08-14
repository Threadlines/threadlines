import { useCanGoBack, useNavigate, useRouter } from "@tanstack/react-router";
import { useCallback } from "react";

/**
 * Returns to the route that opened the current surface, while keeping memory
 * and hash histories inside the app document. Direct entries fall back home.
 */
export function useNavigateBackWithinApp() {
  const navigate = useNavigate();
  const router = useRouter();
  const canGoBack = useCanGoBack();

  return useCallback(() => {
    if (canGoBack) {
      router.history.back();
      return;
    }
    void navigate({ to: "/" });
  }, [canGoBack, navigate, router]);
}
