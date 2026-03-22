import { Outlet } from "@remix-run/react";
import { AnnouncementBar } from "~/components/marketing/AnnouncementBar";
import { ExitIntentModal } from "~/components/marketing/ExitIntentModal";
import { FloatingCTA } from "~/components/marketing/FloatingCTA";
import { Footer } from "~/components/marketing/Footer";
import { Navbar } from "~/components/marketing/Navbar";

export default function MarketingLayout() {
  return (
    <>
      <AnnouncementBar />
      <Navbar />
      <Outlet />
      <Footer />
      <FloatingCTA />
      <ExitIntentModal />
    </>
  );
}
