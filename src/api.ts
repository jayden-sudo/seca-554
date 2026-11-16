import { HttpError } from "./errors.js";
import type { Session } from "./session.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const MAX_RATE_LIMIT_RETRIES = 5;

/**
 * Call https://api.{host}.
 * - 401: the session expired; refresh/re-login once, then retry.
 * - 429: rate limited; wait for Retry-After (else 1s, 2s, 4s...) and retry, then give up with a 503.
 */
export async function api(s: Session, path: string, init: RequestInit = {}): Promise<Response> {
  const send = async () =>
    fetch(`https://api.${s.cfg.host}${path}`, {
      ...init,
      headers: { ...(await s.apiHeaders()), ...init.headers },
    });
  let res = await send();
  let refreshed = false;
  for (let retry = 0; ; ) {
    if (res.status === 401 && !refreshed) {
      refreshed = true;
      await s.refresh();
    } else if (res.status === 429) {
      if (retry >= MAX_RATE_LIMIT_RETRIES) throw new HttpError(503, `secacloud rate limit (429) on ${init.method ?? "GET"} ${path}`);
      const wait = Number(res.headers.get("retry-after"));
      await sleep((Number.isFinite(wait) && wait > 0 ? wait : 2 ** retry) * 1000);
      retry++;
    } else break;
    res = await send();
  }
  if (!res.ok) throw new Error(`${init.method ?? "GET"} ${path} -> ${res.status} ${await res.text()}`);
  return res;
}

export async function apiJson<T>(s: Session, path: string, init?: RequestInit): Promise<T> {
  return (await api(s, path, init)).json() as Promise<T>;
}
