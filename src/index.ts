import cron from "node-cron";
import { CRON_SCHEDULE, RUN_ON_START, SCRAPER_API_KEY } from "./config.js";
import { fetchTennisTournaments, fetchTournamentOdds } from "./draftkings.js";
import { transformDKResponse, SportEventInsert } from "./transformer.js";
import { uploadEvents } from "./uploader.js";

async function scrape(): Promise<void> {
  const startTime = Date.now();
  console.log(`\n${"=".repeat(60)}`);
  console.log(
    `[Scraper] Starting DraftKings tennis odds scrape at ${new Date().toISOString()}`
  );
  console.log(`${"=".repeat(60)}`);

  try {
    // Step 1: Discover active tennis tournaments not covered by Odds API
    const tournaments = await fetchTennisTournaments();

    if (tournaments.length === 0) {
      console.log("[Scraper] No uncovered tournaments found. Done.");
      return;
    }

    // Step 2: Fetch odds for each tournament
    const allEvents: SportEventInsert[] = [];

    for (const tournament of tournaments) {
      try {
        const response = await fetchTournamentOdds(tournament.eventGroupId);
        if (!response) continue;

        const events = transformDKResponse(response, tournament.name);
        allEvents.push(...events);

        // 1s delay between requests to avoid rate limiting
        await new Promise((r) => setTimeout(r, 1000));
      } catch (err) {
        console.error(`[Scraper] Error processing ${tournament.name}:`, err);
      }
    }

    console.log(`\n[Scraper] Total events scraped: ${allEvents.length}`);

    // Step 3: Upload to Supabase via edge function
    if (allEvents.length > 0) {
      await uploadEvents(allEvents);
    }

    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(
      `[Scraper] Completed in ${duration}s. ${allEvents.length} events processed.\n`
    );
  } catch (err) {
    console.error("[Scraper] Fatal error:", err);
  }
}

// ── Startup ──

if (!SCRAPER_API_KEY) {
  console.warn(
    "[Config] WARNING: SCRAPER_API_KEY is not set. Uploads will fail."
  );
}

console.log(`[Config] Proxy: ${process.env.PROXY_URL ? "configured" : "not set (direct connection)"}`);
console.log(`[Scheduler] Cron schedule: ${CRON_SCHEDULE}`);
console.log(`[Scheduler] Run on start: ${RUN_ON_START}`);
cron.schedule(CRON_SCHEDULE, scrape);

if (RUN_ON_START) {
  scrape();
}
