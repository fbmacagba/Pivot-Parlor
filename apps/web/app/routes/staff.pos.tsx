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
  return posLoader(args, "staff");
}

export function action(args: ActionFunctionArgs) {
  return posAction(args, "staff");
}

export default function StaffPos() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  return <PosScreen {...data} actionData={actionData} />;
}

export function ErrorBoundary() {
  return <ErrorScreen homeHref="/staff" homeLabel="Back to today" />;
}
