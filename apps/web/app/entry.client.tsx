import { RemixBrowser } from "@remix-run/react";
import { startTransition } from "react";
import { hydrateRoot } from "react-dom/client";
import { installBrowserErrorReporter, reportBrowserError } from "./lib/browserErrorReporter";

// JavaScript errors in this page reach the alert email (app/lib/browserErrors.ts).
installBrowserErrorReporter();

startTransition(() => {
  hydrateRoot(document, <RemixBrowser />, {
    // React recovers from these by rendering on the client; by default it
    // only hands them to reportError. They are hydration failures, so they
    // are reported as that, and still logged to the console.
    onRecoverableError(error) {
      reportBrowserError(error, "hydration");
      console.error(error);
    },
  });
});
