import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const cron = JSON.parse(read("wrangler.cron.jsonc"));
const collector = JSON.parse(read("wrangler.wechat.jsonc"));
const scripts = JSON.parse(read("package.json")).scripts;
assert.equal(cron.vars.CLOUDFLARE_WECHAT_ENABLED, "false");
assert(!cron.vars.CLOUDFLARE_PRIMARY_NEWS_SOURCES.split(",").includes("wechat"));
assert(!cron.services.some(({ binding }) => binding === "WECHAT_COLLECTOR"));
assert.equal(collector.workers_dev, false);
assert(!collector.containers?.length);
assert(!scripts["cf:deploy:wechat"]);
assert(!scripts["cf:deploy"].includes("cf:deploy:wechat"));
assert(!read("client/src/pages/SentimentMonitor.tsx").includes("geo-seo-system-wechat.hans-pan007.workers.dev"));
console.log("WeChat collection, container deployment and UI entry remain disabled.");
