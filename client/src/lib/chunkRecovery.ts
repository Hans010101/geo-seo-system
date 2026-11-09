// Recovery for lazy-chunk load failures after a deploy.
//
// Right after a Pages deploy a browser can request a new hashed chunk before every edge has it;
// the SPA fallback then answers with index.html (200), and the zone's 4-hour browser cache keeps
// that HTML under the .js URL, so every lazy page fails with "Failed to fetch dynamically
// imported module" until the cache expires (seen 2026-11-09). A plain reload reuses the bad
// cache entries, so we re-download every asset the app references first, then reload once.

const GUARD_KEY = "chunk-recovery-at";
const GUARD_MS = 60_000;

export function isChunkLoadError(error: unknown): boolean {
  const text = String((error as Error)?.message || error || "");
  return /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module|Unable to preload CSS/i.test(text);
}

async function assetUrls(): Promise<string[]> {
  const urls = new Set<string>();
  for (const entry of performance.getEntriesByType("resource")) {
    if (entry.name.includes("/assets/")) urls.add(entry.name.split("?")[0]);
  }
  const entries = Array.from(document.querySelectorAll<HTMLScriptElement | HTMLLinkElement>(
    'script[src*="/assets/"], link[href*="/assets/"]',
  )).map(el => ("src" in el && el.src) || (el as HTMLLinkElement).href);
  for (const url of entries) {
    urls.add(url);
    if (!url.endsWith(".js")) continue;
    try {
      // The entry lists every lazy chunk (Vite's preload map); refresh those too.
      const text = await (await fetch(url, { cache: "reload" })).text();
      for (const match of Array.from(text.matchAll(/assets\/([\w.-]+\.(?:js|css))/g))) {
        urls.add(new URL(`/assets/${match[1]}`, location.origin).href);
      }
    } catch {
      // keep going with what we have
    }
  }
  return Array.from(urls);
}

/** Re-download every app asset (bypassing the HTTP cache), then reload. At most once a minute. */
export async function refreshAssetsAndReload(): Promise<void> {
  let last = 0;
  try { last = Number(sessionStorage.getItem(GUARD_KEY) || 0); } catch { /* storage blocked */ }
  if (Date.now() - last < GUARD_MS) return;
  try { sessionStorage.setItem(GUARD_KEY, String(Date.now())); } catch { /* storage blocked */ }
  const urls = await assetUrls();
  await Promise.all(urls.map(url => fetch(url, { cache: "reload" }).catch(() => undefined)));
  location.reload();
}

/** Vite fires this when a lazy chunk's preload fails; recover instead of showing the error. */
export function installChunkRecovery(): void {
  window.addEventListener("vite:preloadError", (event) => {
    event.preventDefault();
    void refreshAssetsAndReload();
  });
}
