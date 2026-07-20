import { googleMapsEmbedUrl, googleMapsUrl } from "@repo/utils";
import { ThemedButton } from "~/components/ThemedBookingControls";

/** Compact shop map + directions link for the booking confirmation screen.
 *  Kept out of the route file so it renders in jsdom without Remix mocks. */
export function BookingConfirmMap({ address }: { address: string }) {
  return (
    <div className="mt-8 flex flex-col gap-3">
      <div className="aspect-[16/10] overflow-hidden rounded-[var(--st-r-lg)] border border-[color:var(--st-line-card)] bg-[color:var(--st-card-5)]">
        <iframe
          title="Map"
          className="h-full w-full border-0"
          loading="lazy"
          referrerPolicy="no-referrer-when-downgrade"
          src={googleMapsEmbedUrl(address)}
        />
      </div>
      <ThemedButton asChild size="lg" variant="ghost">
        <a href={googleMapsUrl(address)} target="_blank" rel="noopener noreferrer">
          Get directions
        </a>
      </ThemedButton>
    </div>
  );
}
