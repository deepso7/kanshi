/* oxlint-disable sort-keys -- parameter and output order mirrors the endpoint contracts */
import { defineEndpoint, node, p, t } from "@tinybirdco/sdk";

import { analyticsReadToken } from "./tokens.ts";

const rangeValidation = `
  SELECT throwIf(
    toDateTime64({{DateTime64(end)}}, 3) <= toDateTime64({{DateTime64(start)}}, 3)
      OR dateDiff(
        'second',
        toDateTime64({{DateTime64(start)}}, 3),
        toDateTime64({{DateTime64(end)}}, 3)
      ) > 2678400,
    'time range must be positive and cannot exceed 31 days'
  ) AS valid
`;

const uptimeValidation = `
  {% if String(bucket) != '1m' and String(bucket) != '5m' and String(bucket) != '1h' and String(bucket) != '1d' %}
    {{ error("bucket must be one of '1m', '5m', '1h', or '1d'") }}
  {% end %}
  ${rangeValidation}
`;

export const monitorHistory = defineEndpoint("monitor_history", {
  description: "Deduplicated probe samples for a monitor",
  params: {
    monitor_id: p.string(),
    start: p.dateTime64(),
    end: p.dateTime64(),
    limit: p.uint16().optional(500),
    cursor: p.string().optional(),
  },
  nodes: [
    node({
      name: "history_range_validation",
      sql: rangeValidation,
    }),
    node({
      name: "deduplicated_history",
      sql: `
        SELECT
          checks.monitor_id AS monitor_id,
          checks.check_id AS check_id,
          checks.region AS region,
          argMax(checks.scheduled_at, checks.ingested_at) AS scheduled_at,
          argMax(checks.probed_at, checks.ingested_at) AS probed_at,
          max(checks.ingested_at) AS ingested_at,
          argMax(checks.ok, checks.ingested_at) AS ok,
          tupleElement(argMax(tuple(checks.status), checks.ingested_at), 1) AS status,
          tupleElement(argMax(tuple(checks.latency_ms), checks.ingested_at), 1) AS latency_ms,
          tupleElement(argMax(tuple(checks.error_kind), checks.ingested_at), 1) AS error_kind,
          argMax(checks.revision, checks.ingested_at) AS revision
        FROM checks
        WHERE (SELECT valid FROM history_range_validation) = 0
          AND checks.monitor_id = {{String(monitor_id)}}
          AND checks.scheduled_at >= {{DateTime64(start)}}
          AND checks.scheduled_at < {{DateTime64(end)}}
        GROUP BY checks.monitor_id, checks.check_id, checks.region
      `,
    }),
    node({
      name: "history_endpoint",
      sql: `
        {% if UInt16(limit, 500) < 1 or UInt16(limit, 500) > 1000 %}
          {{ error('limit must be between 1 and 1000') }}
        {% end %}

        SELECT
          history.check_id AS check_id,
          history.monitor_id AS monitor_id,
          history.region AS region,
          history.scheduled_at AS scheduled_at,
          history.probed_at AS probed_at,
          history.ingested_at AS ingested_at,
          history.ok AS ok,
          history.status AS status,
          history.latency_ms AS latency_ms,
          history.error_kind AS error_kind,
          history.revision AS revision,
          base64Encode(
            concat(
              formatDateTime(history.scheduled_at, '%Y-%m-%d %H:%i:%S.%f'),
              '\u001F',
              history.check_id,
              '\u001F',
              history.region
            )
          ) AS cursor
        FROM deduplicated_history AS history
        WHERE (SELECT valid FROM history_range_validation) = 0
          {% if defined(cursor) %}
          AND tuple(
            history.scheduled_at,
            history.check_id,
            history.region
          ) > tuple(
            parseDateTime64BestEffort(
              splitByChar('\u001F', base64Decode({{String(cursor)}}))[1],
              3
            ),
            splitByChar('\u001F', base64Decode({{String(cursor)}}))[2],
            splitByChar('\u001F', base64Decode({{String(cursor)}}))[3]
          )
          {% end %}
        ORDER BY history.scheduled_at, history.check_id, history.region
        LIMIT {{UInt16(limit, 500)}}
      `,
    }),
  ],
  output: {
    check_id: t.string(),
    monitor_id: t.string(),
    region: t.string(),
    scheduled_at: t.dateTime64(3),
    probed_at: t.dateTime64(3),
    ingested_at: t.dateTime64(3),
    ok: t.uint8(),
    status: t.uint16().nullable(),
    latency_ms: t.uint32().nullable(),
    error_kind: t.string().nullable(),
    revision: t.uint32(),
    cursor: t.string(),
  },
  tokens: [{ token: analyticsReadToken, scope: "READ" }],
});

export const monitorUptime = defineEndpoint("monitor_uptime", {
  description: "Best-effort uptime and coverage rollups for a monitor",
  params: {
    monitor_id: p.string(),
    start: p.dateTime64(),
    end: p.dateTime64(),
    bucket: p.string(),
  },
  nodes: [
    node({
      name: "uptime_range_validation",
      sql: uptimeValidation,
    }),
    node({
      name: "deduplicated_manifest",
      sql: `
        SELECT
          check_manifest.monitor_id AS monitor_id,
          check_manifest.check_id AS check_id,
          argMax(check_manifest.scheduled_at, check_manifest.enqueued_at) AS scheduled_at,
          argMax(check_manifest.regions_expected, check_manifest.enqueued_at)
            AS regions_expected,
          argMax(check_manifest.failure_quorum, check_manifest.enqueued_at)
            AS failure_quorum
        FROM check_manifest
        WHERE (SELECT valid FROM uptime_range_validation) = 0
          AND check_manifest.monitor_id = {{String(monitor_id)}}
          AND check_manifest.scheduled_at >= {{DateTime64(start)}}
          AND check_manifest.scheduled_at < {{DateTime64(end)}}
        GROUP BY check_manifest.monitor_id, check_manifest.check_id
      `,
    }),
    node({
      name: "deduplicated_checks",
      sql: `
        SELECT
          checks.monitor_id AS monitor_id,
          checks.check_id AS check_id,
          checks.region AS region,
          argMax(checks.scheduled_at, checks.ingested_at) AS scheduled_at,
          argMax(checks.ok, checks.ingested_at) AS ok,
          tupleElement(argMax(tuple(checks.latency_ms), checks.ingested_at), 1) AS latency_ms
        FROM checks
        WHERE (SELECT valid FROM uptime_range_validation) = 0
          AND checks.monitor_id = {{String(monitor_id)}}
          AND checks.scheduled_at >= {{DateTime64(start)}}
          AND checks.scheduled_at < {{DateTime64(end)}}
        GROUP BY checks.monitor_id, checks.check_id, checks.region
      `,
    }),
    node({
      name: "check_samples",
      sql: `
        SELECT
          monitor_id,
          check_id,
          any(scheduled_at) AS scheduled_at,
          count() AS regions_observed,
          countIf(ok = 1) AS successes,
          countIf(ok = 0) AS failures
        FROM deduplicated_checks
        GROUP BY monitor_id, check_id
      `,
    }),
    node({
      name: "check_universe",
      sql: `
        SELECT monitor_id, check_id FROM deduplicated_manifest
        UNION DISTINCT
        SELECT monitor_id, check_id FROM check_samples
      `,
    }),
    node({
      name: "check_states",
      sql: `
        SELECT
          universe.monitor_id AS monitor_id,
          universe.check_id AS check_id,
          multiIf(
            {{String(bucket)}} = '1m',
            toStartOfMinute(coalesce(manifest.scheduled_at, samples.scheduled_at)),
            {{String(bucket)}} = '5m',
            toStartOfInterval(
              coalesce(manifest.scheduled_at, samples.scheduled_at),
              INTERVAL 5 MINUTE
            ),
            {{String(bucket)}} = '1h',
            toStartOfHour(coalesce(manifest.scheduled_at, samples.scheduled_at)),
            {{String(bucket)}} = '1d',
            toStartOfDay(coalesce(manifest.scheduled_at, samples.scheduled_at)),
            toStartOfDay(coalesce(manifest.scheduled_at, samples.scheduled_at))
          ) AS bucket_start,
          coalesce(manifest.regions_expected, 1) AS regions_expected,
          manifest.check_id IS NOT NULL AS manifest_present,
          coalesce(samples.regions_observed, 0) AS regions_observed,
          multiIf(
            coalesce(samples.failures, 0) >= coalesce(manifest.failure_quorum, 1),
            'down',
            toInt64(coalesce(manifest.regions_expected, 1))
                - toInt64(coalesce(samples.successes, 0))
              < toInt64(coalesce(manifest.failure_quorum, 1)),
            'up',
            'unknown'
          ) AS state
        FROM check_universe AS universe
        LEFT JOIN deduplicated_manifest AS manifest
          ON universe.monitor_id = manifest.monitor_id
          AND universe.check_id = manifest.check_id
        LEFT JOIN check_samples AS samples
          ON universe.monitor_id = samples.monitor_id
          AND universe.check_id = samples.check_id
      `,
    }),
    node({
      name: "state_rollup",
      sql: `
        SELECT
          bucket_start,
          countIf(manifest_present) AS checks_expected,
          countIf(state = 'up') AS checks_up,
          countIf(state = 'down') AS checks_down,
          countIf(state = 'unknown') AS checks_unknown,
          sum(regions_expected) AS regions_expected,
          sum(regions_observed) AS regions_observed
        FROM check_states
        GROUP BY bucket_start
      `,
    }),
    node({
      name: "latency_rollup",
      sql: `
        SELECT
          states.bucket_start AS bucket_start,
          countIf(checks.latency_ms IS NOT NULL) AS latency_count,
          quantileExactIf(0.5)(
            checks.latency_ms,
            checks.latency_ms IS NOT NULL
          ) AS p50_latency_ms,
          quantileExactIf(0.95)(
            checks.latency_ms,
            checks.latency_ms IS NOT NULL
          ) AS p95_latency_ms,
          quantileExactIf(0.99)(
            checks.latency_ms,
            checks.latency_ms IS NOT NULL
          ) AS p99_latency_ms
        FROM check_states AS states
        INNER JOIN deduplicated_checks AS checks
          ON states.monitor_id = checks.monitor_id
          AND states.check_id = checks.check_id
        GROUP BY states.bucket_start
      `,
    }),
    node({
      name: "uptime_endpoint",
      sql: `
        SELECT
          states.bucket_start AS bucket_start,
          states.checks_expected AS checks_expected,
          states.checks_up AS checks_up,
          states.checks_down AS checks_down,
          states.checks_unknown AS checks_unknown,
          states.regions_expected AS regions_expected,
          states.regions_observed AS regions_observed,
          if(
            states.checks_up + states.checks_down = 0,
            NULL,
            states.checks_up / (states.checks_up + states.checks_down)
          ) AS uptime_ratio,
          if(
            coalesce(latency.latency_count, 0) = 0,
            NULL,
            latency.p50_latency_ms
          ) AS p50_latency_ms,
          if(
            coalesce(latency.latency_count, 0) = 0,
            NULL,
            latency.p95_latency_ms
          ) AS p95_latency_ms,
          if(
            coalesce(latency.latency_count, 0) = 0,
            NULL,
            latency.p99_latency_ms
          ) AS p99_latency_ms
        FROM state_rollup AS states
        LEFT JOIN latency_rollup AS latency
          ON states.bucket_start = latency.bucket_start
        WHERE (SELECT valid FROM uptime_range_validation) = 0
        ORDER BY states.bucket_start
      `,
    }),
  ],
  output: {
    bucket_start: t.dateTime(),
    checks_expected: t.uint64(),
    checks_up: t.uint64(),
    checks_down: t.uint64(),
    checks_unknown: t.uint64(),
    regions_expected: t.uint64(),
    regions_observed: t.uint64(),
    uptime_ratio: t.float64().nullable(),
    p50_latency_ms: t.uint32().nullable(),
    p95_latency_ms: t.uint32().nullable(),
    p99_latency_ms: t.uint32().nullable(),
  },
  tokens: [{ token: analyticsReadToken, scope: "READ" }],
});
