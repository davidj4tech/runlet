// The Cloudflare API, as the installer and `sasonica client` both use it:
// a bearer token, JSON in and out, and Cloudflare's own success flag checked
// rather than the HTTP status alone.
//
// Throws rather than exiting, so each caller decides what a failure means --
// the installer dies, `sasonica client` prints the reason and returns 1.

export const CF_API = 'https://api.cloudflare.com/client/v4';

export async function cfRequest(pathname, { method = 'GET', body, token, api = CF_API } = {}) {
  const r = await fetch(`${api}${pathname}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(60_000),
  });
  const out = await r.json().catch(() => null);
  if (!out?.success) {
    throw new Error(`Cloudflare: ${(out?.errors ?? []).map((e) => e.message).join('; ') || r.status}`);
  }
  return out.result;
}

// One SQL statement against a D1 database over the HTTP API (D1: Edit), with
// bound parameters. Returns the statement's rows and its meta (changes,
// last_row_id).
export async function d1Query({ api, token, accountId, dbId }, sql, params = []) {
  const result = await cfRequest(`/accounts/${accountId}/d1/database/${dbId}/query`,
    { method: 'POST', body: { sql, params }, token, api });
  const first = Array.isArray(result) ? result[0] : result;
  if (first && first.success === false) throw new Error(`D1: ${first.error ?? 'query failed'}`);
  return { rows: first?.results ?? [], meta: first?.meta ?? {} };
}
