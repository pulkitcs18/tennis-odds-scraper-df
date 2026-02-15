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
 * Navigate to the DraftKings tennis page and intercept ALL network
 * responses to capture eventGroup data. DK's own JavaScript makes
 * API calls with proper auth headers that pass the WAF — we just
 * listen for the responses.
 *
 * Also logs every non-static network response for debugging, so
 * we can see exactly what API endpoints DK's frontend uses.
 */
export async function fetchAllTournamentOdds(
  page: Page,
  tournaments: DKTournament[]
): Promise<Map<number, DKEventGroupResponse>> {
  const targetIds = new Set(tournaments.map((t) => t.eventGroupId));
  const results = new Map<number, DKEventGroupResponse>();
  const apiLog: string[] = [];

  const handler = async (
    resp: import("puppeteer-core").HTTPResponse
  ) => {
    const url = resp.url();
    const status = resp.status();

    // Skip static assets
    if (
      /\.(js|css|png|svg|jpg|jpeg|gif|webp|woff2?|ttf|eot|ico)(\?|$)/i.test(
        url
      )
    )
      return;
    if (url.startsWith("data:")) return;

    const shortUrl = url.length > 200 ? url.substring(0, 200) + "..." : url;
    apiLog.push(`[${status}] ${shortUrl}`);

    if (status !== 200) return;

    // Only try to parse JSON responses
    const ct = resp.headers()["content-type"] || "";
    if (!ct.includes("json") && !ct.includes("javascript")) return;

    try {
      const json = await resp.json();

      // Single eventGroup response (v5 API format)
      if (json?.eventGroup?.eventGroupId) {
        const egId = json.eventGroup.eventGroupId;
        if (targetIds.has(egId)) {
          results.set(egId, json as DKEventGroupResponse);
          console.log(
            `[DK] Captured eventGroup ${egId} (${json.eventGroup.name}) from: ${shortUrl}`
          );
        }
      }

      // Array of eventGroups
      if (Array.isArray(json)) {
        for (const item of json) {
          if (item?.eventGroup?.eventGroupId) {
            const egId = item.eventGroup.eventGroupId;
            if (targetIds.has(egId)) {
              results.set(egId, item as DKEventGroupResponse);
              console.log(
                `[DK] Captured eventGroup ${egId} from array response`
              );
            }
          }
        }
      }

      // Nested structure — some DK endpoints wrap data differently
      if (json?.events || json?.offers || json?.eventGroup === undefined) {
        // Log structure for discovery
        const keys = Object.keys(json).slice(0, 10).join(", ");
        if (keys && !keys.includes("html")) {
          apiLog.push(`  ^ JSON keys: ${keys}`);
        }
      }
    } catch {
      // Not valid JSON — skip
    }
  };

  page.on("response", handler);

  // Try navigating to the DK tennis page
  const tennisUrls = [
    "https://sportsbook.draftkings.com/leagues/tennis",
    "https://sportsbook.draftkings.com/sport/tennis",
  ];

  for (const url of tennisUrls) {
    if (results.size === targetIds.size) break;

    console.log(`[DK] Navigating to ${url}...`);
    try {
      await page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: 60000,
      });

      const landedUrl = page.url();
      console.log(`[DK] Landed on: ${landedUrl}`);

      // Wait for DK's JS to make API calls
      await new Promise((r) => setTimeout(r, 15000));

      console.log(
        `[DK] After ${url}: captured ${results.size}/${targetIds.size} tournaments`
      );

      if (results.size > 0) break;
    } catch (err) {
      console.log(`[DK] Navigation to ${url} failed: ${err}`);
    }
  }

  page.off("response", handler);

  // Debug: log all non-static responses
  console.log(`\n[DK Debug] ${apiLog.length} API/network responses:`);
  for (const line of apiLog) {
    console.log(`  ${line}`);
  }

  // Summary
  console.log(
    `\n[DK] Captured data for ${results.size}/${tournaments.length} tournaments:`
  );
  for (const t of tournaments) {
    const found = results.has(t.eventGroupId);
    const r = results.get(t.eventGroupId);
    const eventCount = r?.eventGroup?.events?.length ?? 0;
    console.log(
      `  ${found ? "OK" : "MISSING"} ${t.name} (${t.eventGroupId})${found ? ` — ${eventCount} events` : ""}`
    );
  }

  return results;
}
