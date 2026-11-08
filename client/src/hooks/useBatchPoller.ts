import { useCallback, useEffect, useRef, useState } from "react";
import { trpc } from "@/lib/trpc";

export function useBatchPoller() {
  const [batchId, setBatchId] = useState<string | null>(null);
  const [total, setTotal] = useState(0);
  const [done, setDone] = useState(0);
  const [failed, setFailed] = useState(0);
  const activeRef = useRef(0);
  const startedAtRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { data: progress, error, dataUpdatedAt } = trpc.collections.batchProgress.useQuery(
    { batchId: batchId ?? "" },
    { enabled: !!batchId, refetchInterval: 3000, refetchIntervalInBackground: true, staleTime: 0, retry: 1 },
  );

  const stop = useCallback(() => {
    activeRef.current++;
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
  }, []);

  const start = useCallback((id: string, totalCount: number, execute = true) => {
    stop();
    const generation = activeRef.current;
    startedAtRef.current = Date.now();
    setBatchId(id);
    setTotal(totalCount);
    setDone(0);
    setFailed(0);
    if (!execute) return;

    const run = async () => {
      if (generation !== activeRef.current) return;
      try {
        const res = await fetch("/api/trpc/collections.executeNextBatch", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ json: { batchId: id, concurrency: 5 } }),
        });
        const json = await res.json();
        const result = json?.result?.data?.json ?? json?.result?.data;
        if (!res.ok || json.error || !Number.isInteger(result?.remaining)) {
          throw new Error(json.error?.json?.message || "采集执行接口异常");
        }
        // Execution returns per-round deltas; only the independent query owns progress.
        if (result.remaining === 0) return;
      } catch (err) {
        console.warn("[Poller] execution error:", err);
      }
      if (generation === activeRef.current) timerRef.current = setTimeout(run, 2000);
    };
    void run();
  }, [stop]);

  useEffect(() => {
    if (!batchId || !progress || progress.total === 0 || dataUpdatedAt < startedAtRef.current) return;
    setTotal(progress.total);
    setDone(progress.completed);
    // Terminal statuses include timeout, even on older servers that omit it from failed.
    setFailed(progress.total - progress.completed - progress.pending);
    if (progress.pending === 0) {
      stop();
      setBatchId(null);
    }
  }, [batchId, progress, dataUpdatedAt, stop]);

  useEffect(() => () => stop(), [stop]);

  return {
    batchId, total, done, failed,
    pct: total > 0 ? Math.round(((done + failed) / total) * 100) : 0,
    isRunning: !!batchId, start, stop,
    syncError: !!batchId && !!error,
  };
}
