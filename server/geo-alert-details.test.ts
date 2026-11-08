// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Home from "../client/src/pages/Home";

const state = vi.hoisted(() => ({ alerts: [] as any[] }));
vi.mock("@/lib/trpc", () => ({ trpc: {
  useUtils: () => ({}),
  dashboard: { summary: { useQuery: () => ({}) }, heatmap: { useQuery: () => ({}) } },
  questions: { list: { useQuery: () => ({}) } },
  alerts: { list: { useQuery: () => ({ data: { data: state.alerts, total: state.alerts.length } }) } },
} }));
vi.mock("@/components/MonitorArticleDetailSheet", () => ({ default: ({ articleId, open, onOpenChange }: any) =>
  open ? createElement("div", { role: "dialog" }, `文章详情 ${articleId}`,
    createElement("button", { onClick: () => onOpenChange(false) }, "关闭文章")) : null,
}));
vi.mock("@/components/CollectionDetailSheet", () => ({ default: ({ collectionId, open, onOpenChange }: any) =>
  open ? createElement("div", { role: "dialog" }, `采集详情 ${collectionId}`,
    createElement("button", { onClick: () => onOpenChange(false) }, "关闭采集")) : null,
}));

describe("GEO latest alert details", () => {
  let root: Root;
  let container: HTMLDivElement;
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    state.alerts = [{ id: 1, title: "孙宇晨相关预警", severity: "high", createdAt: 0 }];
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });
  async function openAlert() {
    await act(async () => root.render(createElement(Home)));
    const button = container.querySelector<HTMLButtonElement>('button[aria-haspopup="dialog"]')!;
    expect(button.type).toBe("button");
    expect(button.getAttribute("aria-label")).toContain("查看预警详情");
    await act(async () => button.click());
  }
  it("opens article details and closes without changing alert state", async () => {
    state.alerts[0].relatedArticleId = 42;
    await openAlert();
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("文章详情 42");
    await act(async () => container.querySelector<HTMLButtonElement>('[role="dialog"] button')!.click());
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });
  it("keeps GEO collection details available", async () => {
    state.alerts[0].relatedCollectionId = 87;
    await openAlert();
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("采集详情 87");
  });
  it("shows the complete fallback description and original source", async () => {
    state.alerts[0].description = "完整预警内容\n原文: https://x.com/example/status/123";
    await openAlert();
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain(state.alerts[0].description);
    const link = dialog.querySelector("a")!;
    expect(link.href).toBe("https://x.com/example/status/123");
    expect(link.target).toBe("_blank");
    expect(link.rel).toBe("noopener noreferrer");
  });
  it("handles alerts with no description or associated record", async () => {
    await openAlert();
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain("暂无详细说明");
    expect(dialog.querySelector("a")).toBeNull();
  });
});
