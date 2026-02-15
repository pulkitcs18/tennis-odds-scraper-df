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
 * Create a browser page, apply stealth settings, and navigate to
 * sportsbook.draftkings.com to establish session cookies on
 * .draftkings.com — these carry over when we navigate to the
 * sportsbook-nash.draftkings.com API URLs.
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

  // Visit DK sportsbook to establish session cookies on .draftkings.com
  console.log("[Browser] Navigating to DraftKings to establish session...");
  await page.goto("https://sportsbook.draftkings.com", {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });
  await new Promise((r) => setTimeout(r, 5000));

  const cookies = await page.cookies();
  console.log(
    `[Browser] Session established. ${cookies.length} cookies set. Landed on: ${page.url()}`
  );

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
 * Fetch odds for a specific tournament by navigating the browser
 * directly to the DraftKings v5 API URL. This is a top-level
 * navigation (not a JS fetch), so there's no CORS. The browser
 * sends session cookies established during createDKPage().
 *
 * page.goto() returns the HTTP response directly, so we can
 * read the JSON without any interception tricks.
 */
export async function fetchTournamentOdds(
  page: Page,
  eventGroupId: number
): Promise<DKEventGroupResponse | null> {
  const apiUrl = `${DK_ODDS_BASE_URL}/${eventGroupId}?format=json`;

  console.log(
    `[DK] Fetching odds for eventGroup ${eventGroupId} via direct navigation...`
  );

  try {
    const response = await page.goto(apiUrl, {
      waitUntil: "networkidle0",
      timeout: 30000,
    });

    if (!response) {
      console.error(`[DK] No response for eventGroup ${eventGroupId}`);
      return null;
    }

    const status = response.status();
    console.log(`[DK] eventGroup ${eventGroupId}: HTTP ${status}`);

    if (status !== 200) {
      const text = await response.text().catch(() => "");
      console.error(
        `[DK] eventGroup ${eventGroupId} returned ${status}: ${text.substring(0, 200)}`
      );
      return null;
    }

    // The browser renders JSON as text — read it from the response
    let json: any;
    try {
      json = await response.json();
    } catch {
      // Some browsers wrap JSON in HTML <pre> tags — extract from page
      const bodyText = await page.evaluate(() => document.body?.innerText || "");
      console.log(
        `[DK] response.json() failed, trying page body (${bodyText.length} chars)...`
      );
      json = JSON.parse(bodyText);
    }

    if (!json?.eventGroup) {
      console.error(
        `[DK] eventGroup ${eventGroupId}: response has no eventGroup key`
      );
      console.log(
        `[DK] Response keys: ${Object.keys(json || {}).join(", ")}`
      );
      return null;
    }

    const eventCount = json.eventGroup?.events?.length ?? 0;
    const categoryCount = json.eventGroup?.offerCategories?.length ?? 0;
    console.log(
      `[DK] eventGroup ${eventGroupId}: ${eventCount} events, ${categoryCount} offer categories`
    );

    return json as DKEventGroupResponse;
  } catch (err) {
    console.error(`[DK] Failed for eventGroup ${eventGroupId}:`, err);
    return null;
  }
}
