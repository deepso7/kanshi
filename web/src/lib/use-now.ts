import { useEffect, useState } from "react";

/**
 * The current time (epoch ms), refreshed every `intervalMs` (15 s by
 * default), for relative times such as `formatAgo(at, now)`.
 */
export const useNow = (intervalMs = 15_000): number => {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
};
