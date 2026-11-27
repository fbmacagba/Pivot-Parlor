import { useActionData, useLoaderData } from "react-router";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { ErrorScreen } from "~/components/ErrorScreen";
import { PosScreen } from "~/components/pos/PosScreen";
import { pageTitle } from "~/lib/pageTitle";
import { posAction, posLoader } from "~/lib/pos";
import { revalidateAfterFailedSubmission } from "~/lib/revalidation";

// Reload this page's data after a failed submission, as Remix 2 did (app/lib/revalidation.ts).
export const shouldRevalidate = revalidateAfterFailedSubmission;

export const meta = () => pageTitle("Point of Sale");

export function loader(args: LoaderFunctionArgs) {
  return posLoader(args, "admin");
}

export function action(args: ActionFunctionArgs) {
  return posAction(args, "admin");
}

export default function AdminPos() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  return <PosScreen {...data} actionData={actionData} />;
}

export function ErrorBoundary() {
  return <ErrorScreen homeHref="/admin" homeLabel="Back to overview" />;
}
