import { Link, useLocation } from "wouter";

// Second-level switch inside one GEO 洞察 tab (e.g. 信源与引用 = 引用源分析 · 己方 URL).
export type SubNavItem = { label: string; path: string };

export const GEO_SOURCES_NAV: SubNavItem[] = [
  { label: "引用源分析", path: "/citations" },
  { label: "己方 URL", path: "/config/our-content" },
];
export const GEO_SETUP_NAV: SubNavItem[] = [
  { label: "问题库", path: "/config/questions" },
  { label: "采集任务", path: "/config/collection" },
];

export function GeoSubNav({ items }: { items: SubNavItem[] }) {
  const [location] = useLocation();
  return (
    <div className="inline-flex rounded-lg border bg-muted/40 p-0.5 text-sm">
      {items.map(item => {
        const active = location === item.path;
        return (
          <Link key={item.path} href={item.path}
            className={`rounded-md px-3 py-1 transition-colors ${active ? "bg-background font-medium shadow-sm" : "text-muted-foreground hover:text-foreground"}`}>
            {item.label}
          </Link>
        );
      })}
    </div>
  );
}
