import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import puppeteer, { type Browser, type CookieData, type Page } from "puppeteer";
import type { Config } from "./config.js";

/** Values copied from the web app's own requests; not derivable from config. */
export const APP = {
  appVersion: "4.2.1",
  pollMs: 3000,
  maxUnknownPolls: 10,
};

export interface Session {
  cfg: Config;
  browser: Browser;
  /** The long-lived logged-in page that keepAlive() refreshes. UI automation should use newPage() instead. */
  page: Page;
  /** Headers for direct calls to https://api.{host}, built from the browser's current cookies and CSRF token. */
  apiHeaders: () => Promise<Record<string, string>>;
  /** Reload the logged-in page; logs in again if the session was lost. Concurrent calls share one run. */
  refresh: () => Promise<void>;
  /** A fresh tab for UI automation; its API requests also update the captured CSRF token. */
  newPage: () => Promise<Page>;
  close: () => Promise<void>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const isSeca = (c: { domain: string }) => /(^|\.)secacloud\.com$/.test(c.domain.replace(/^\./, ""));

/** The login cookie is a session cookie (dropped when the browser closes), so keep a copy on disk. */
const sessionDir = () => resolve(process.env.SECA_SESSION_DIR ?? ".session");
const cookieFile = () => join(sessionDir(), "cookies.json");

async function restoreCookies(browser: Browser): Promise<void> {
  try {
    const saved = JSON.parse(await readFile(cookieFile(), "utf8")) as CookieData[];
    if (saved.length) await browser.setCookie(...saved);
  } catch {
    // no saved session yet
  }
}

async function saveCookies(browser: Browser): Promise<void> {
  const keep = (await browser.cookies()).filter(isSeca);
  await mkdir(join(cookieFile(), ".."), { recursive: true });
  await writeFile(cookieFile(), JSON.stringify(keep), { mode: 0o600 });
}

export async function login(cfg: Config): Promise<Session> {
  // A killed browser or a replaced container (new hostname) leaves lock files behind, and Chrome then refuses to start
  // with "profile in use by another computer". This process is the profile's only user, so the locks are stale.
  for (const f of ["SingletonLock", "SingletonSocket", "SingletonCookie"]) {
    await rm(join(sessionDir(), "profile", f), { force: true });
  }
  const browser = await puppeteer.launch({
    // Headed: the site's API rejects headless Chrome (403 on the preflight). In Docker run under Xvfb.
    headless: false,
    // The persistent profile keeps the page's local storage, which together with the cookies makes
    // the saved session valid (cookies alone get a 401 because the CSRF token is missing).
    userDataDir: join(sessionDir(), "profile"),
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });
  const ua = await browser.userAgent();
  const base = `https://${cfg.host}/${cfg.tenant}`;

  // The CSRF token and app version are not documented: copy them from the app's own API requests.
  let csrf = "";
  let appVersion = APP.appVersion;
  const newPage = async () => {
    const p = await browser.newPage();
    await p.setViewport({ width: 1280, height: 900 });
    p.on("request", (req) => {
      if (new URL(req.url()).host === `api.${cfg.host}`) {
        const h = req.headers();
        csrf = h["x-csrf-token"] ?? csrf;
        appVersion = h["scl-app-version"] ?? appVersion;
      }
    });
    return p;
  };

  /** Poll every 3s: at /home -> done; Login button -> fill the form; otherwise count an unknown state. */
  async function waitLoggedIn(page: Page): Promise<void> {
    let unknown = 0;
    let submitted = false;
    while (unknown < APP.maxUnknownPolls) {
      await sleep(APP.pollMs);
      if (page.url().startsWith(`${base}/home`)) {
        console.error(submitted ? "logged in with username/password" : "session valid");
        return;
      }
      const hasLogin = await page.evaluate(() =>
        [...document.querySelectorAll("button")].some((b) => b.textContent?.trim() === "Login"),
      );
      if (!hasLogin) {
        unknown++;
        continue;
      }
      unknown = 0;
      submitted = true;
      for (const [sel, value] of [
        ["input[formcontrolname=externalTenantId]", cfg.tenant],
        ["input[formcontrolname=username]", cfg.user],
        ["input[formcontrolname=password]", cfg.password],
      ] as const) {
        const box = await page.$(sel);
        if (!box) continue;
        await box.click({ count: 3 });
        await page.keyboard.press("Backspace");
        await box.type(value);
      }
      await page.evaluate(() =>
        [...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Login")?.click(),
      );
    }
    throw new Error(`Login failed: state undetermined after ${APP.maxUnknownPolls} polls`);
  }

  const page = await newPage();
  try {
    await restoreCookies(browser); // a still-valid session redirects straight to /home
    await page.goto(`${base}/guest/login?accountType=analytics125`);
    await waitLoggedIn(page);
    await saveCookies(browser);
    // Wait for the app to make an API call so the CSRF token is captured.
    for (let i = 0; i < 10 && !csrf; i++) await sleep(1000);
    if (!csrf) throw new Error("Could not capture x-csrf-token from the app's API requests");
  } catch (e) {
    await browser.close();
    throw e;
  }

  const apiHeaders = async () => {
    const cookies = (await browser.cookies()).filter(isSeca);
    return {
      accept: "application/json, text/plain, */*",
      "content-type": "application/json",
      cookie: cookies.map((c) => `${c.name}=${c.value}`).join("; "),
      origin: `https://${cfg.host}`,
      "scl-app-type": "web",
      "scl-app-version": appVersion,
      "user-agent": ua,
      "scl-page-url": `${base}/patients`,
      "x-csrf-token": csrf,
    };
  };

  let refreshing: Promise<void> | null = null;
  const refresh = () =>
    (refreshing ??= (async () => {
      try {
        // Enter via the login URL: a valid session is redirected to /home, a lost one stays on the login form.
        await page.goto(`${base}/guest/login?accountType=analytics125`, { waitUntil: "domcontentloaded" });
        await waitLoggedIn(page);
        await saveCookies(browser);
        // The URL alone doesn't prove the session works; ask the API.
        const check = await fetch(`https://api.${cfg.host}/api/back-office/v1/identity`, { headers: await apiHeaders() });
        if (!check.ok) throw new Error(`Session check failed after login: ${check.status}`);
      } finally {
        refreshing = null;
      }
    })());

  return {
    cfg,
    browser,
    page,
    refresh,
    newPage,
    close: () => browser.close(),
    apiHeaders,
  };
}

/** Keep the session alive by refreshing the logged-in page every `everyMs`. Returns a stop function. */
export function keepAlive(s: Session, everyMs = 60_000, log: (msg: string) => void = console.error): () => void {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  const tick = async () => {
    try {
      await s.refresh();
    } catch (e) {
      log(`keepAlive refresh failed, will retry: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!stopped) timer = setTimeout(tick, everyMs); // next wait starts after the run ends, so runs never overlap
  };
  timer = setTimeout(tick, everyMs);
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}
