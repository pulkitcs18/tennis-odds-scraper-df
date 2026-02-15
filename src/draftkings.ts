import puppeteer, { Browser, Page } from "puppeteer-core";
import {
  DK_NAV_URL,
  DK_ODDS_BASE_URL,
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
 * Create a fresh browser page with stealth settings.
 * Does NOT navigate anywhere — each fetchTournamentOdds call
 * navigates to the specific tournament page.
 */
export async function createDKPage(): Promise<Page> {
  if (!browser) throw new Error("Browser not launched");

  const page = await browser.newPage();
  await page.setViewport({ width: 1920, height: 1080 });
  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36"
  );

  // Stealth: hide webdriver flag
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => false });
  });

  console.log("[Browser] Page created with stealth settings");
  return page;
}

// ── Types for DraftKings API responses ──

export interface DKTournament {
  eventGroupId: number;
  name: string;
}

export interface DKEvent {
  eventId: number;
  name: string;
  startDate: string;
  teamName1: string;
  teamName2: string;
  eventStatus?: { state: string };
}

export interface DKOutcome {
  label: string;
  oddsDecimal: number;
  oddsAmerican: string;
  line?: number;
  participant?: string;
}

export interface DKOffer {
  providerEventId?: string;
  eventId?: number;
  label: string;
  outcomes: DKOutcome[];
  isSuspended?: boolean;
}

export interface DKEventGroupResponse {
  eventGroup: {
    eventGroupId: number;
    name: string;
    events?: DKEvent[];
    offerCategories?: Array<{
      offerCategoryId: number;
      name: string;
      offerSubcategoryDescriptors?: Array<{
        subcategoryId: number;
        name: string;
        offerSubcategory?: {
          offers?: DKOffer[][];
        };
      }>;
    }>;
  };
}

/**
 * Fetch all active tennis tournaments from DraftKings nav API.
 * This endpoint is NOT geo-blocked — uses plain fetch (no browser needed).
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
    console.log(
      "[DK] Available sports:",
      groups
        .map((g: any) => `${g.displayName} (${g.displayGroupId})`)
        .join(", ")
    );
    return [];
  }

  const eventGroups: any[] = tennisSport.eventGroupInfos || [];
  const tournaments: DKTournament[] = [];

  for (const eg of eventGroups) {
    const name: string = eg.eventGroupName || eg.displayName || eg.name || "";
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

    tournaments.push({ eventGroupId, name });
  }

  console.log(
    `[DK] Found ${tournaments.length} uncovered tournaments to scrape`
  );
  for (const t of tournaments) {
    console.log(`  - ${t.name} (eventGroupId: ${t.eventGroupId})`);
  }

  return tournaments;
}

/**
 * Fetch odds for a specific tournament by navigating to the DraftKings
 * tournament page and intercepting the API response that DK's own
 * JavaScript makes. This avoids CORS issues since DK's code makes the
 * API call with proper headers/tokens.
 */
export async function fetchTournamentOdds(
  page: Page,
  eventGroupId: number
): Promise<DKEventGroupResponse | null> {
  const tournamentPageUrl = `https://sportsbook.draftkings.com/leagues/tennis/${eventGroupId}`;
  const apiUrlPattern = `/eventgroups/${eventGroupId}`;

  console.log(
    `[DK] Navigating to tournament page for eventGroup ${eventGroupId}...`
  );

  try {
    // Set up a promise that resolves when we intercept the API response
    const apiResponsePromise = new Promise<DKEventGroupResponse | null>(
      (resolve) => {
        const timeout = setTimeout(() => {
          console.log(
            `[DK] Timeout waiting for API response for eventGroup ${eventGroupId}`
          );
          resolve(null);
        }, 30000);

        const handler = async (response: import("puppeteer-core").HTTPResponse) => {
          const url = response.url();
          if (!url.includes(apiUrlPattern)) return;

          try {
            const status = response.status();
            if (status !== 200) {
              console.log(
                `[DK] Intercepted API response for ${eventGroupId} with status ${status}`
              );
              return; // Don't resolve — might get a retry
            }

            const json = await response.json();
            if (json?.eventGroup) {
              clearTimeout(timeout);
              page.off("response", handler);
              resolve(json as DKEventGroupResponse);
            }
          } catch {
            // JSON parse error — ignore and keep waiting
          }
        };

        page.on("response", handler);
      }
    );

    // Navigate to the tournament page
    await page.goto(tournamentPageUrl, {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });

    // Wait for DK's JS to load and fire API requests
    const result = await apiResponsePromise;

    if (!result) {
      console.error(
        `[DK] No API response intercepted for eventGroup ${eventGroupId}`
      );
      return null;
    }

    const eventCount = result.eventGroup?.events?.length ?? 0;
    const categoryCount = result.eventGroup?.offerCategories?.length ?? 0;
    console.log(
      `[DK] eventGroup ${eventGroupId}: ${eventCount} events, ${categoryCount} offer categories`
    );

    return result;
  } catch (err) {
    console.error(`[DK] Failed for eventGroup ${eventGroupId}:`, err);
    return null;
  }
}
