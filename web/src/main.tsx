import "./index.css";
import { CSPProvider } from "@base-ui/react/csp-provider";
import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { Toaster } from "./components/ui/toast.tsx";
import { TooltipProvider } from "./components/ui/tooltip.tsx";
import { queryClient, router } from "./router.tsx";
import { ThemeProvider } from "./theme/theme-provider.tsx";

const container = document.querySelector("#root");
if (container === null) {
  throw new Error("index.html has no #root element");
}

createRoot(container).render(
  <StrictMode>
    {/* No inline <style> from Base UI: the CSP allows 'self' styles only. */}
    <CSPProvider disableStyleElements>
      <ThemeProvider>
        <TooltipProvider>
          <QueryClientProvider client={queryClient}>
            <RouterProvider router={router} />
          </QueryClientProvider>
          <Toaster />
        </TooltipProvider>
      </ThemeProvider>
    </CSPProvider>
  </StrictMode>
);
