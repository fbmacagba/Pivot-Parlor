import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/cloudflare";
import { useActionData, useLoaderData } from "@remix-run/react";
import { PosScreen } from "~/components/pos/PosScreen";
import { posAction, posLoader } from "~/lib/pos";

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
