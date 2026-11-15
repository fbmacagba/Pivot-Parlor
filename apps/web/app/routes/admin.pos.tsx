import { useActionData, useLoaderData } from "react-router";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { PosScreen } from "~/components/pos/PosScreen";
import { posAction, posLoader } from "~/lib/pos";
import { revalidateAfterFailedSubmission } from "~/lib/revalidation";

// Reload this page's data after a failed submission, as Remix 2 did (app/lib/revalidation.ts).
export const shouldRevalidate = revalidateAfterFailedSubmission;

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
