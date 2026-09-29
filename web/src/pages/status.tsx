import { useQuery } from "@tanstack/react-query";

import { publicStatusQuery } from "../api/queries.ts";

/** Placeholder until the public status page is ported. */
export const StatusPage = () => {
  const status = useQuery(publicStatusQuery);
  return (
    <>
      <h1>Status</h1>
      {status.data === undefined ? (
        <p>Loading…</p>
      ) : (
        <p>
          {status.data.overall}: {status.data.monitors.length} public monitors
        </p>
      )}
    </>
  );
};
