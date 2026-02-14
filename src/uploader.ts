import { SUPABASE_URL, SCRAPER_API_KEY } from "./config.js";
import { SportEventInsert } from "./transformer.js";

const EDGE_FUNCTION_URL = `${SUPABASE_URL}/functions/v1/save-draftkings-tennis`;

/**
 * Upload transformed events to Supabase via the save-draftkings-tennis
 * edge function, which upserts them into the sports_events table.
 */
export async function uploadEvents(events: SportEventInsert[]): Promise<void> {
  if (events.length === 0) {
    console.log("[Upload] No events to upload");
    return;
  }

  console.log(`[Upload] Sending ${events.length} events to edge function...`);

  const res = await fetch(EDGE_FUNCTION_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${SCRAPER_API_KEY}`,
    },
    body: JSON.stringify({ events }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Upload failed (${res.status}): ${body}`);
  }

  const result = await res.json();
  console.log(
    `[Upload] Success: ${result.events_processed} events upserted at ${result.timestamp}`
  );
}
