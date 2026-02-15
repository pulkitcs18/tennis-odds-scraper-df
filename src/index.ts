import cron from "node-cron";
import { CRON_SCHEDULE, RUN_ON_START, SCRAPER_API_KEY } from "./config.js";
import {
  launchBrowser,
  closeBrowser,
  createDKPage,
  fetchTennisTournaments,
  fetchAllTournamentOdds,
} from "./draftkings.js";
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
    // Step 1: Discover active tennis tournaments (plain fetch, no browser)
    const tournaments = await fetchTennisTournaments();

    if (tournaments.length === 0) {
      console.log("[Scraper] No uncovered tournaments found. Done.");
      return;
    }

    // Step 2: Launch browser and establish DK session
    await launchBrowser();
    const page = await createDKPage();

    // Step 3: Navigate to DK tennis page and intercept all odds data
    const oddsMap = await fetchAllTournamentOdds(page, tournaments);

    // Step 4: Transform captured data
    const allEvents: SportEventInsert[] = [];

    for (const tournament of tournaments) {
      const response = oddsMap.get(tournament.eventGroupId);
      if (!response) continue;

      try {
        const events = transformDKResponse(response, tournament.name);
        allEvents.push(...events);
      } catch (err) {
        console.error(`[Scraper] Error transforming ${tournament.name}:`, err);
      }
    }

    // Close the page (but keep browser alive for next cycle)
    await page.close();

    console.log(`\n[Scraper] Total events scraped: ${allEvents.length}`);

    // Step 5: Upload to Supabase
    if (allEvents.length > 0) {
      await uploadEvents(allEvents);
    }

    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(
      `[Scraper] Completed in ${duration}s. ${allEvents.length} events processed.\n`
    );
  } catch (err) {
    console.error("[Scraper] Fatal error:", err);
    // Close browser on fatal error so it gets relaunched next cycle
    await closeBrowser();
  }
}

// ── Startup ──

if (!SCRAPER_API_KEY) {
  console.warn(
    "[Config] WARNING: SCRAPER_API_KEY is not set. Uploads will fail."
  );
}

console.log(`[Scheduler] Cron schedule: ${CRON_SCHEDULE}`);
console.log(`[Scheduler] Run on start: ${RUN_ON_START}`);
cron.schedule(CRON_SCHEDULE, scrape);

if (RUN_ON_START) {
  scrape();
}
