import { isRouteErrorResponse, Link, useRouteError } from "@remix-run/react";
import { Button } from "~/components/ui/Button";

interface ErrorScreenProps {
  /** When true, fills the viewport (root-level fallback). Otherwise fills its container. */
  fullscreen?: boolean;
}

/**
 * Branded error fallback for Remix ErrorBoundary exports. Renders a friendly
 * message instead of the app white-screening when a loader/action throws or a
 * route responds with an error status.
 */
export function ErrorScreen({ fullscreen = false }: ErrorScreenProps) {
  const error = useRouteError();

  let status = 500;
  let title = "Something went wrong";
  let message =
    "An unexpected error occurred. Please try again. If it keeps happening, get in touch and we'll sort it out.";

  if (isRouteErrorResponse(error)) {
    status = error.status;
    if (status === 404) {
      title = "Page not found";
      message = "The page you're looking for doesn't exist or may have moved.";
    } else if (status === 401 || status === 403) {
      title = "Access denied";
      message = "You don't have permission to view this page. Try signing in again.";
    } else if (status >= 500) {
      title = "Service unavailable";
      message =
        "We're having trouble loading this right now. This is usually temporary. Please try again in a moment.";
    } else {
      title = error.statusText || title;
    }
  }

  return (
    <div
      className={`flex ${fullscreen ? "min-h-screen" : "min-h-[50vh]"} flex-col items-center justify-center px-6 text-center`}
    >
      <p className="font-heading text-6xl font-bold text-gold">{status}</p>
      <h1 className="mt-4 font-heading text-2xl font-bold text-white">{title}</h1>
      <p className="mt-3 max-w-md text-sm text-white/70">{message}</p>
      <div className="mt-8 flex gap-3">
        <Button asChild variant="outline">
          <Link to="/">Go home</Link>
        </Button>
        <Button onClick={() => window.location.reload()}>Try again</Button>
      </div>
    </div>
  );
}
