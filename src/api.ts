import type { Session } from "./session.js";

export async function api(s: Session, path: string, init: RequestInit = {}): Promise<Response> {
  const res = await fetch(`https://api.${s.cfg.host}${path}`, {
    ...init,
    headers: { ...(await s.apiHeaders()), ...init.headers },
  });
  if (!res.ok) throw new Error(`${init.method ?? "GET"} ${path} -> ${res.status} ${await res.text()}`);
  return res;
}

export async function apiJson<T>(s: Session, path: string, init?: RequestInit): Promise<T> {
  return (await api(s, path, init)).json() as Promise<T>;
}
