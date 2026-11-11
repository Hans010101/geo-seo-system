// Shared by 行业动态 and 行业报告.
export const CATEGORY_TONE: Record<string, string> = {
  regulation: "bg-violet-50 text-violet-700 border-violet-200",
  macro: "bg-amber-50 text-amber-700 border-amber-200",
  stablecoin: "bg-emerald-50 text-emerald-700 border-emerald-200",
  exchange: "bg-sky-50 text-sky-700 border-sky-200",
  chain: "bg-indigo-50 text-indigo-700 border-indigo-200",
  institution: "bg-teal-50 text-teal-700 border-teal-200",
  tokenization: "bg-fuchsia-50 text-fuchsia-700 border-fuchsia-200",
  security: "bg-red-50 text-red-700 border-red-200",
  market: "bg-slate-50 text-slate-700 border-slate-200",
  other: "bg-zinc-50 text-zinc-600 border-zinc-200",
};
export const bjTime = (ms: number, withDate = true) => {
  const text = new Date(ms + 8 * 3_600_000).toISOString();
  return withDate ? `${text.slice(5, 10)} ${text.slice(11, 16)}` : text.slice(11, 16);
};
export const bjDay = (ms: number) => new Date(ms + 8 * 3_600_000).toISOString().slice(0, 10);
