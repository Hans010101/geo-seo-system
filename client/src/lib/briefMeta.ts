// Shared by 早晚报 and the 工作台 最新研判 card.
export const BRIEF_LIGHT: Record<string, { icon: string; bg: string }> = {
  平稳: { icon: "🟢", bg: "bg-green-600" }, 关注: { icon: "🟡", bg: "bg-amber-600" },
  警戒: { icon: "🟠", bg: "bg-orange-600" }, 危机: { icon: "🔴", bg: "bg-red-700" },
};
export const BRIEF_TREND: Record<string, { text: string; cls: string }> = {
  up: { text: "▲ 升温", cls: "text-red-600" }, down: { text: "▼ 缓和", cls: "text-green-600" },
  flat: { text: "● 持平", cls: "text-muted-foreground" }, new: { text: "◆ 新增", cls: "text-blue-600" },
  closed: { text: "✓ 结案", cls: "text-muted-foreground" },
};
