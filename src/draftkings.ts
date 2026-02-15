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
 * Navigate to the DraftKings tennis section and intercept ALL network
 * responses to capture event/odds data. DK's own JavaScript makes
 * API calls with proper auth headers that pass the WAF.
 *
 * Strategy:
 * 1. From the homepage, find the Tennis navigation link in the DOM
 * 2. Click it (SPA routing) to navigate to the tennis section
 * 3. Intercept all API responses and capture event/odds data
 * 4. Log all responses for debugging
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

    const ct = resp.headers()["content-type"] || "";
    if (!ct.includes("json")) return;

    try {
      const json = await resp.json();

      // v5 eventGroup format
      if (json?.eventGroup?.eventGroupId) {
        const egId = json.eventGroup.eventGroupId;
        if (targetIds.has(egId)) {
          results.set(egId, json as DKEventGroupResponse);
          console.log(
            `[DK] Captured eventGroup ${egId} (${json.eventGroup.name})`
          );
        }
      }

      // Log structure of DK API responses for discovery
      if (
        url.includes("sportscontent") ||
        url.includes("sportslayout") ||
        url.includes("sportsstructure") ||
        url.includes("eventgroup") ||
        url.includes("events") ||
        url.includes("markets")
      ) {
        const keys = Object.keys(json).slice(0, 15).join(", ");
        apiLog.push(`  ^ keys: ${keys}`);

        // Deep-log interesting nested data
        if (json.navigation) {
          const navStr = JSON.stringify(json.navigation).substring(0, 300);
          apiLog.push(`  ^ navigation: ${navStr}`);
        }
        if (json.events) {
          const count = Array.isArray(json.events)
            ? json.events.length
            : "obj";
          apiLog.push(`  ^ events: ${count}`);
          if (Array.isArray(json.events) && json.events[0]) {
            apiLog.push(
              `  ^ first event keys: ${Object.keys(json.events[0]).slice(0, 10).join(", ")}`
            );
          }
        }
        if (json.data) {
          const dataStr = JSON.stringify(json.data).substring(0, 300);
          apiLog.push(`  ^ data: ${dataStr}`);
        }
        if (json.layout) {
          const layoutStr = JSON.stringify(json.layout).substring(0, 300);
          apiLog.push(`  ^ layout: ${layoutStr}`);
        }
      }
    } catch {
      // Not valid JSON — skip
    }
  };

  page.on("response", handler);

  // ── Step 1: Find and log ALL navigation links on the DK homepage ──
  console.log("[DK] Scanning homepage for navigation links...");
  const allLinks = await page.evaluate(() => {
    const result: Array<{ href: string; text: string }> = [];
    document.querySelectorAll("a[href]").forEach((a) => {
      const href = a.getAttribute("href") || "";
      const text = (a.textContent || "").trim().substring(0, 60);
      if (href && text && text.length > 1 && text.length < 40) {
        result.push({ href, text });
      }
    });
    return result;
  });

  // Find sport-related links
  const sportKeywords = [
    "tennis",
    "football",
    "basketball",
    "baseball",
    "hockey",
    "soccer",
    "golf",
    "mma",
    "boxing",
    "nfl",
    "nba",
    "mlb",
    "nhl",
  ];
  const sportLinks = allLinks.filter((l) =>
    sportKeywords.some((kw) => l.text.toLowerCase().includes(kw))
  );

  console.log(`[DK] Found ${allLinks.length} links, ${sportLinks.length} sport-related:`);
  for (const link of sportLinks) {
    console.log(`  ${link.text}: ${link.href}`);
  }

  // ── Step 2: Find tennis link and navigate ──
  const tennisLink = allLinks.find(
    (l) => l.text.toLowerCase().trim() === "tennis"
  ) || allLinks.find((l) => l.text.toLowerCase().includes("tennis"));

  if (tennisLink) {
    const tennisUrl = tennisLink.href.startsWith("http")
      ? tennisLink.href
      : `https://sportsbook.draftkings.com${tennisLink.href}`;

    console.log(`[DK] Found tennis link: "${tennisLink.text}" → ${tennisUrl}`);
    await page.goto(tennisUrl, {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });
    await new Promise((r) => setTimeout(r, 10000));
    console.log(`[DK] Landed on: ${page.url()}`);
  } else {
    // Fallback: click on "Tennis" text in the DOM (SPA routing)
    console.log("[DK] No tennis <a> link found. Trying to click Tennis element...");
    const clicked = await page.evaluate(() => {
      // Try clicking elements that just say "Tennis"
      const allElements = document.querySelectorAll(
        'a, button, [role="link"], [role="button"], [role="tab"], li, span, div'
      );
      for (const el of allElements) {
        const text = el.textContent?.trim();
        if (
          text?.toLowerCase() === "tennis" &&
          el.children.length <= 2
        ) {
          (el as HTMLElement).click();
          return `Clicked ${el.tagName}.${el.className}: "${text}"`;
        }
      }
      return null;
    });

    if (clicked) {
      console.log(`[DK] ${clicked}`);
      await new Promise((r) => setTimeout(r, 10000));
      console.log(`[DK] After click, URL: ${page.url()}`);
    } else {
      console.log("[DK] Could not find any Tennis element to click");
    }
  }

  // ── Step 3: On the tennis page, look for tournament links ──
  console.log(
    `[DK] After tennis navigation: captured ${results.size}/${targetIds.size} tournaments`
  );

  if (results.size < targetIds.size) {
    // Log what links are available on this page now
    const pageLinks = await page.evaluate(() => {
      const result: Array<{ href: string; text: string }> = [];
      document.querySelectorAll("a[href]").forEach((a) => {
        const href = a.getAttribute("href") || "";
        const text = (a.textContent || "").trim().substring(0, 80);
        if (href && text) result.push({ href, text });
      });
      return result;
    });

    const tennisPageLinks = pageLinks.filter(
      (l) =>
        l.text.toLowerCase().includes("atp") ||
        l.text.toLowerCase().includes("wta") ||
        l.text.toLowerCase().includes("delray") ||
        l.text.toLowerCase().includes("rio") ||
        l.text.toLowerCase().includes("midland") ||
        l.text.toLowerCase().includes("open") ||
        l.href.includes("tennis")
    );

    console.log(
      `[DK] Tennis-related links on current page (${tennisPageLinks.length}):`
    );
    for (const link of tennisPageLinks.slice(0, 30)) {
      console.log(`  ${link.text}: ${link.href}`);
    }

    // Try clicking on each tournament
    for (const tournament of tournaments) {
      if (results.has(tournament.eventGroupId)) continue;

      const tournamentName = tournament.name
        .replace(/^(ATP|WTA)\s*-\s*/, "")
        .toLowerCase();

      const matchingLink = tennisPageLinks.find(
        (l) =>
          l.text.toLowerCase().includes(tournamentName) ||
          l.href.includes(String(tournament.eventGroupId))
      );

      if (matchingLink) {
        console.log(
          `[DK] Clicking tournament: ${matchingLink.text} (${matchingLink.href})`
        );
        const url = matchingLink.href.startsWith("http")
          ? matchingLink.href
          : `https://sportsbook.draftkings.com${matchingLink.href}`;
        await page.goto(url, {
          waitUntil: "domcontentloaded",
          timeout: 60000,
        });
        await new Promise((r) => setTimeout(r, 10000));
        console.log(`[DK] Landed on: ${page.url()}`);
      }
    }
  }

  page.off("response", handler);

  // ── Debug output ──
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
