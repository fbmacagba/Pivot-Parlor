import { X } from "lucide-react";
import { useEffect, useState } from "react";

const DISMISS_KEY = "pp_announcement_dismissed_v1";

export function AnnouncementBar() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!localStorage.getItem(DISMISS_KEY)) {
      setVisible(true);
    }
  }, []);

  if (!visible) return null;

  return (
    <div
      className="relative flex items-center justify-center bg-gold px-10 py-2.5 text-center text-sm font-medium text-dark"
      role="banner"
    >
      <span>
        Limited spots available:{" "}
        <a href="/contact" className="underline underline-offset-2 font-semibold">
          get your shop live for £100
        </a>
      </span>
      <button
        onClick={() => {
          setVisible(false);
          localStorage.setItem(DISMISS_KEY, "1");
        }}
        className="absolute right-3 top-1/2 -translate-y-1/2 rounded-full p-1 hover:bg-dark/10 transition-colors"
        aria-label="Dismiss"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
