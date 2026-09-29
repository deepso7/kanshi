import type { ComponentProps } from "react";

import { formatAgo, formatUtc } from "../lib/format.ts";
import { useNow } from "../lib/use-now.ts";

export type RelativeTimeProps = Omit<
  ComponentProps<"time">,
  "children" | "dateTime" | "title"
> & {
  /** Epoch ms, or `null` for "never". */
  readonly at: number | null;
  /** Pass a shared `useNow()` in long lists instead of one timer per row. */
  readonly now?: number;
};

/** `5m ago`, ticking, with the UTC time as its tooltip. */
export const RelativeTime = ({ at, now, ...props }: RelativeTimeProps) => {
  const ticking = useNow();
  const current = now ?? ticking;
  if (at === null) {
    return <span {...props}>{formatAgo(null, current)}</span>;
  }
  return (
    <time
      {...props}
      dateTime={new Date(at).toISOString()}
      title={formatUtc(at)}
    >
      {formatAgo(at, current)}
    </time>
  );
};
