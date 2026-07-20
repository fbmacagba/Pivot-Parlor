import { Outlet } from "@remix-run/react";

// Layout for /dev/shops and its nested routes. The shops list lives in
// dev.shops._index.tsx; the child detail routes (dev.shops.$shopId.*) nest
// here. This Outlet is what renders the matched child — without it, clicking
// "Details" (→ /dev/shops/:id), "Preview", or opening a generation page changed
// the URL but rendered nothing, so the list stayed put and the link looked dead.
export default function DevShopsLayout() {
  return <Outlet />;
}
