import { createContext, useContext } from "react";

/**
 * The nonce this page's inline scripts carry, the one the response's
 * Content-Security-Policy names (app/lib/securityHeaders.ts). entry.server.tsx
 * provides it from the request's load context; in the browser it is
 * undefined, and Remix's script elements suppress the hydration mismatch.
 */
export const CspNonceContext = createContext<string | undefined>(undefined);

export function useCspNonce(): string | undefined {
  return useContext(CspNonceContext);
}
