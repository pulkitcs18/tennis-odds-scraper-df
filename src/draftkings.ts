import puppeteer, { Browser, Page } from "puppeteer-core";
import {
  DK_NAV_URL,
  TENNIS_DISPLAY_GROUP_ID,
  shouldSkipTournament,
} from "./config.js";

// ── Browser management ──

let browser: Browser | null = null;

export async function launchBrowser(): Promise<void> {
  if (browser) return;

  const executablePath =
    process.env.PUPPETEER_EXECUTABLE_PATH || "/usr/bin/chromium";

  console.log(`[Browser] Launching Chrome from ${executablePath}...`);
  browser = await puppeteer.launch({
    headless: true,
    executablePath,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--disable-software-rasterizer",
      "--disable-blink-features=AutomationControlled",
    ],
  });
  console.log("[Browser] Chrome launched");
}

export async function closeBrowser(): Promise<void> {
  if (browser) {
    await browser.close();
    browser = null;
    console.log("[Browser] Chrome closed");
  }
}

/**
 * Create a browser page, apply stealth settings, and navigate to
 * sportsbook.draftkings.com to establish session cookies.
 */
export async function createDKPage(): Promise<Page> {
  if (!browser) throw new Error("Browser not launched");

  const page = await browser.newPage();
  await page.setViewport({ width: 1920, height: 1080 });
  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36"
  );

  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => false });
  });

  console.log("[Browser] Navigating to DraftKings to establish session...");
  await page.goto("https://sportsbook.draftkings.com", {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });
  await new Promise((r) => setTimeout(r, 5000));

  const cookies = await page.cookies();
  console.log(
    `[Browser] Session established. ${cookies.length} cookies set.`
  );

  return page;
}

// ── Types for DraftKings Content API ──

export interface DKTournament {
  eventGroupId: number;
  name: string;
  seoIdentifier?: string;
}

export interface DKContentEvent {
  id: string;
  name: string;
  startEventDate: string;
  leagueId: string;
  status: string;
  participants: Array<{
    name: string;
    venueRole: string;
  }>;
}

export interface DKContentMarket {
  id: string;
  eventId: string;
  name: string;
  marketType: { name: string };
}

export interface DKContentSelection {
  marketId: string;
  label: string;
  displayOdds: {
    american: string;
    decimal: string;
  };
  trueOdds: number;
  outcomeType: string;
  participants?: Array<{
    name: string;
    venueRole: string;
  }>;
}

export interface DKContentResponse {
  leagues: Array<{ id: string; name: string }>;
  events: DKContentEvent[];
  markets: DKContentMarket[];
  selections: DKContentSelection[];
}

/**
 * Fetch all active tennis tournaments from DraftKings nav API.
 * Also extracts seoIdentifier for building tournament page URLs.
 */
export async function fetchTennisTournaments(): Promise<DKTournament[]> {
  console.log("[DK] Fetching tennis tournaments from nav API...");

  const res = await fetch(DK_NAV_URL);
  if (!res.ok) {
    throw new Error(`Nav API returned ${res.status}: ${await res.text()}`);
  }

  const data = await res.json();
  const groups: any[] = data.displayGroupInfos || [];

  const tennisSport = groups.find(
    (g: any) =>
      String(g.displayGroupId) === String(TENNIS_DISPLAY_GROUP_ID) ||
      g.displayName?.toLowerCase() === "tennis"
  );

  if (!tennisSport) {
    console.log("[DK] Tennis sport not found in nav response");
    return [];
  }

  const eventGroups: any[] = tennisSport.eventGroupInfos || [];
  const tournaments: DKTournament[] = [];

  for (const eg of eventGroups) {
    const name: string =
      eg.eventGroupName || eg.displayName || eg.name || "";
    const eventGroupId: number | undefined = eg.eventGroupId;

    if (!eventGroupId || !name) continue;

    if (shouldSkipTournament(name)) {
      console.log(`[DK] Skipping "${name}" (covered by Odds API)`);
      continue;
    }

    if (name.toLowerCase().includes("doubles")) {
      console.log(`[DK] Skipping "${name}" (doubles)`);
      continue;
    }

    // Build seoIdentifier from name: "ATP - Delray Beach" → "atp-delray-beach"
    const seoIdentifier =
      eg.seoIdentifier ||
      name
        .toLowerCase()
        .replace(/\s*-\s*/g, "-")
        .replace(/[^a-z0-9-]/g, "")
        .replace(/-+/g, "-");

    tournaments.push({ eventGroupId, name, seoIdentifier });
  }

  console.log(
    `[DK] Found ${tournaments.length} uncovered tournaments to scrape`
  );
  for (const t of tournaments) {
    console.log(`  - ${t.name} (${t.eventGroupId}) → /leagues/tennis/${t.seoIdentifier}`);
  }

  return tournaments;
}

/**
 * Navigate to each tournament page on DraftKings and intercept the
 * sportscontent API responses that DK's own JS makes. These responses
 * contain events, markets, and selections (odds).
 *
 * DK tournament pages: /leagues/tennis/{seoIdentifier}
 * API responses have shape: { events[], markets[], selections[] }
 */
export async function fetchAllTournamentOdds(
  page: Page,
  tournaments: DKTournament[]
): Promise<Map<number, DKContentResponse>> {
  const targetLeagueIds = new Set(
    tournaments.map((t) => String(t.eventGroupId))
  );
  const results = new Map<number, DKContentResponse>();

  // Accumulate all captured data across page loads
  const allEvents: DKContentEvent[] = [];
  const allMarkets: DKContentMarket[] = [];
  const allSelections: DKContentSelection[] = [];

  const handler = async (
    resp: import("puppeteer-core").HTTPResponse
  ) => {
    const url = resp.url();
    const status = resp.status();

    if (status !== 200) return;
    if (
      /\.(js|css|png|svg|jpg|jpeg|gif|webp|woff2?|ttf|eot|ico)(\?|$)/i.test(
        url
      )
    )
      return;

    const ct = resp.headers()["content-type"] || "";
    if (!ct.includes("json")) return;

    try {
      const json = await resp.json();

      // DK Content API: { events[], markets[], selections[] }
      if (
        Array.isArray(json.events) &&
        json.events.length > 0 &&
        Array.isArray(json.selections)
      ) {
        const newEvents = json.events as DKContentEvent[];
        const newMarkets = (json.markets || []) as DKContentMarket[];
        const newSelections = json.selections as DKContentSelection[];

        allEvents.push(...newEvents);
        allMarkets.push(...newMarkets);
        allSelections.push(...newSelections);

        // Log which leagues we captured
        const leagueIds = [
          ...new Set(newEvents.map((e: any) => e.leagueId)),
        ];
        const matchingLeagues = leagueIds.filter((id) =>
          targetLeagueIds.has(id as string)
        );
        if (matchingLeagues.length > 0) {
          console.log(
            `[DK] Captured ${newEvents.length} events, ${newMarkets.length} markets, ${newSelections.length} selections for leagues: ${matchingLeagues.join(", ")}`
          );
        }
      }
    } catch {
      // Not valid JSON
    }
  };

  page.on("response", handler);

  // Navigate to each tournament page
  for (const tournament of tournaments) {
    const slug =
      tournament.seoIdentifier ||
      tournament.name
        .toLowerCase()
        .replace(/\s*-\s*/g, "-")
        .replace(/[^a-z0-9-]/g, "")
        .replace(/-+/g, "-");

    const tournamentUrl = `https://sportsbook.draftkings.com/leagues/tennis/${slug}`;
    console.log(`[DK] Navigating to ${tournamentUrl}...`);

    try {
      await page.goto(tournamentUrl, {
        waitUntil: "domcontentloaded",
        timeout: 60000,
      });
      // Wait for DK's JS to fire API calls
      await new Promise((r) => setTimeout(r, 8000));
      console.log(`[DK] Landed on: ${page.url()}`);
    } catch (err) {
      console.error(`[DK] Navigation failed for ${tournament.name}:`, err);
    }
  }

  // ── Phase 2: Visit each event's detail page for spread/total markets ──
  // Tournament listing pages only return Moneyline. The full market set
  // (spread, total games) is on /event/{slug}/{id}?category=all-odds&subcategory=match-lines

  // Deduplicate events captured so far to build the visit list
  const capturedEvents = new Map<string, DKContentEvent>();
  for (const e of allEvents) capturedEvents.set(e.id, e);

  const upcomingEvents = [...capturedEvents.values()].filter((e) => {
    if (e.status !== "NOT_STARTED") return false;
    return new Date(e.startEventDate) > new Date();
  });

  if (upcomingEvents.length > 0) {
    console.log(
      `\n[DK] Phase 2: Fetching spread/total for ${upcomingEvents.length} events...`
    );

    for (const event of upcomingEvents) {
      // Build event page slug: "Patrick Kypson vs Terence Atmane" → "patrick-kypson-vs-terence-atmane"
      const nameSlug = event.name
        .toLowerCase()
        .replace(/\s+/g, "-")
        .replace(/[^a-z0-9-]/g, "")
        .replace(/-+/g, "-");

      const eventUrl = `https://sportsbook.draftkings.com/event/${nameSlug}/${event.id}?category=all-odds&subcategory=match-lines`;
      console.log(`[DK]   → ${event.name} (${event.id})`);

      try {
        await page.goto(eventUrl, {
          waitUntil: "domcontentloaded",
          timeout: 60000,
        });
        await new Promise((r) => setTimeout(r, 5000));
      } catch (err) {
        console.error(`[DK] Event page failed for ${event.name}:`, err);
      }
    }

    console.log(`[DK] Phase 2 complete.`);
  }

  page.off("response", handler);

  // Deduplicate events by id
  const eventMap = new Map<string, DKContentEvent>();
  for (const e of allEvents) eventMap.set(e.id, e);
  const uniqueEvents = [...eventMap.values()];

  const marketMap = new Map<string, DKContentMarket>();
  for (const m of allMarkets) marketMap.set(m.id, m);

  const selectionMap = new Map<string, DKContentSelection>();
  for (const s of allSelections)
    selectionMap.set(`${s.marketId}_${s.outcomeType}`, s);

  // Split by tournament (leagueId = eventGroupId)
  for (const tournament of tournaments) {
    const leagueId = String(tournament.eventGroupId);
    const events = uniqueEvents.filter((e) => e.leagueId === leagueId);
    if (events.length === 0) continue;

    const eventIds = new Set(events.map((e) => e.id));
    const markets = [...marketMap.values()].filter((m) =>
      eventIds.has(m.eventId)
    );
    const marketIds = new Set(markets.map((m) => m.id));
    const selections = [...selectionMap.values()].filter((s) =>
      marketIds.has(s.marketId)
    );

    results.set(tournament.eventGroupId, {
      leagues: [{ id: leagueId, name: tournament.name }],
      events,
      markets,
      selections,
    });
  }

  // Summary
  console.log(
    `\n[DK] Captured data for ${results.size}/${tournaments.length} tournaments:`
  );
  for (const t of tournaments) {
    const r = results.get(t.eventGroupId);
    if (r) {
      console.log(
        `  OK ${t.name} — ${r.events.length} events, ${r.markets.length} markets, ${r.selections.length} selections`
      );
    } else {
      console.log(`  MISSING ${t.name} (${t.eventGroupId})`);
    }
  }

  return results;
}
