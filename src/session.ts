import puppeteer, { type Browser, type Page } from "puppeteer";
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
  page: Page;
  /** Headers for direct calls to https://api.{host}. */
  apiHeaders: () => Promise<Record<string, string>>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function login(cfg: Config): Promise<Session> {
  const browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });
  const page = await browser.newPage();

  // The CSRF token source is undocumented: copy it from the app's own API requests.
  let csrf = "";
  page.on("request", (req) => {
    if (new URL(req.url()).host === `api.${cfg.host}`) {
      csrf = req.headers()["x-csrf-token"] ?? csrf;
    }
  });

  const base = `https://${cfg.host}/${cfg.tenant}`;
  await page.goto(`${base}/guest/login?accountType=analytics125`);

  let unknown = 0;
  while (unknown < APP.maxUnknownPolls) {
    await sleep(APP.pollMs);
    if (page.url().startsWith(`${base}/home`)) break;

    const hasLogin = await page.evaluate(() =>
      [...document.querySelectorAll("button")].some((b) => b.textContent?.trim() === "Login"),
    );
    if (!hasLogin) {
      unknown++;
      continue;
    }
    unknown = 0;
    // Selectors are assumed (first text/email input + password input); adjust after inspecting the page.
    await page.type('input[type="text"], input[type="email"]', cfg.user);
    await page.type('input[type="password"]', cfg.password);
    await page.evaluate(() =>
      [...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Login")?.click(),
    );
  }
  if (!page.url().startsWith(`${base}/home`)) {
    await browser.close();
    throw new Error("Login failed: state undetermined after 10 polls");
  }

  // Wait for the app to make an API call so the CSRF token is captured.
  for (let i = 0; i < 10 && !csrf; i++) await sleep(1000);
  if (!csrf) {
    await browser.close();
    throw new Error("Could not capture x-csrf-token from the app's API requests");
  }

  return {
    cfg,
    browser,
    page,
    apiHeaders: async () => {
      const cookies = (await browser.cookies()).filter((c) => `.${cfg.host}`.endsWith(c.domain.replace(/^\.?/, ".")));
      return {
        accept: "application/json, text/plain, */*",
        "content-type": "application/json",
        cookie: cookies.map((c) => `${c.name}=${c.value}`).join("; "),
        origin: `https://${cfg.host}`,
        "scl-app-type": "web",
        "scl-app-version": APP.appVersion,
        "scl-page-url": `${base}/patients`,
        "x-csrf-token": csrf,
      };
    },
  };
}
