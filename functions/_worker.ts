/**
 * Cloudflare Pages Functions: Advanced Mode (_worker.ts)
 *
 * This is the single Worker that handles ALL requests to the Pages project.
 * Static assets (Vite build output in dist/public/) are served automatically by
 * Cloudflare Pages. This Worker only handles /api/* routes that fall through.
 *
 * Reference: https://developers.cloudflare.com/pages/functions/advanced-mode/
 */

export { default } from "../workers/index";
