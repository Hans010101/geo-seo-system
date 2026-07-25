// Polyfill MessagePort for undici in Cloudflare Workers
if (typeof (globalThis as any).MessagePort === "undefined") {
  (globalThis as any).MessagePort = class MessagePort {};
}

import { handle } from "hono/cloudflare-pages";
import { app } from "../../workers/index";

export const onRequest = handle(app);
export const onRequestGet = handle(app);
export const onRequestPost = handle(app);
export const onRequestPut = handle(app);
export const onRequestDelete = handle(app);
export const onRequestPatch = handle(app);
export const onRequestOptions = handle(app);
