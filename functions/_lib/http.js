// Small shared helpers for the Pages Functions route handlers.

export function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

// Server-rendered pages (the /b and /s share pages). no-store: they render
// live KV state, and a cached copy would outlive edits or deleted records.
export function html(markup, status = 200) {
  return new Response(markup, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
  });
}

// Parse a JSON request body, tolerating an empty/absent body (-> {}), so a
// handler never throws just because the client sent nothing.
export async function readJson(request) {
  try {
    const text = await request.text();
    if (!text) return {};
    return JSON.parse(text);
  } catch {
    return {};
  }
}
