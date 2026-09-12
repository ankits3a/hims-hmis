import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { AuthProvider } from "./lib/auth";
import { EnvironmentBanner } from "./components/environment-banner";
import { router } from "./router";
import "./lib/i18n";

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, staleTime: 5_000 } },
});

export function App(): React.ReactElement {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        {/*
          11i T3 — OUTSIDE the router on purpose. Every screen is inside it, including Desk One,
          which covers the viewport; a banner mounted per-route would be a banner some routes
          forgot. It is `pointer-events: none` and it renders nothing at all on production.
        */}
        <EnvironmentBanner />
        <RouterProvider router={router} />
      </AuthProvider>
    </QueryClientProvider>
  );
}
