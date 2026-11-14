import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/cloudflare";
import { useActionData, useLoaderData } from "@remix-run/react";
import { PosScreen } from "~/components/pos/PosScreen";
import { posAction, posLoader } from "~/lib/pos";
import { revalidateAfterFailedSubmission } from "~/lib/revalidation";

// Reload this page's data after a failed submission, as Remix 2 did (app/lib/revalidation.ts).
export const shouldRevalidate = revalidateAfterFailedSubmission;

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
