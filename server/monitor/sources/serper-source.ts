// Serper news wrapped as a SocialSource. Returns url+snippet (no fullContent) → pipeline fetches full
// text via the fetch router (unchanged behavior).
import { searchNews } from "../search";
import { parseSerperDate } from "../util";
import { searchPublishers } from "./publisher-search";
import type { SocialSource, DiscoveredPost, SearchOpts } from "./types";

export const serperSource: SocialSource = {
  name: "serper",
  platform: "web",
  enabled: true,
  async search(keyword: string, opts?: SearchOpts): Promise<DiscoveredPost[]> {
    let items;
    try {
      items = await searchNews(keyword, opts);
    } catch (error) {
      console.warn(JSON.stringify({ event: "news.publisher_fallback", keyword }));
      opts?.onFallback?.(String((error as Error)?.message || error).slice(0, 160));
      try { return await searchPublishers(keyword); } catch (fallbackError) {
        throw new AggregateError([error, fallbackError], "Serper and public publisher search failed");
      }
    }
    return items.map((it): DiscoveredPost => ({
      url: it.url,
      title: it.title || "",
      contentSnippet: it.snippet || "",
      author: it.source || null,
      publishedAt: parseSerperDate(it.date),
      sourceName: "serper",
      sourcePlatform: "web",
    }));
  },
};
