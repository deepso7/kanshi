import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http";
import type { UrlParams } from "effect/unstable/http";

export interface TinybirdClientConfig {
  readonly baseUrl: string;
  readonly appendToken: string;
  readonly readToken: string;
}

export type TinybirdDatasource = "check_manifest" | "checks";
export type TinybirdEndpoint = "monitor_history" | "monitor_uptime";

const IngestResponse = Schema.Struct({
  quarantined_rows: Schema.Int,
  successful_rows: Schema.Int,
});

export class TinybirdRowsQuarantined extends Schema.TaggedErrorClass<TinybirdRowsQuarantined>()(
  "TinybirdRowsQuarantined",
  {
    datasource: Schema.String,
    quarantinedRows: Schema.Int,
    successfulRows: Schema.Int,
  }
) {}

export const appendRows = Effect.fn("TinybirdClient.appendRows")(
  function* appendRowsEffect(
    config: TinybirdClientConfig,
    datasource: TinybirdDatasource,
    rows: readonly Readonly<Record<string, unknown>>[]
  ) {
    if (rows.length === 0) {
      return;
    }

    yield* Effect.annotateCurrentSpan({
      "tinybird.datasource": datasource,
      "tinybird.operation": "ingest",
      "tinybird.requested_rows": rows.length,
    });

    const client = yield* HttpClient.HttpClient;
    const body = `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;

    const result = yield* HttpClientRequest.post(
      new URL("/v0/events", config.baseUrl)
    ).pipe(
      HttpClientRequest.setUrlParams({ name: datasource, wait: true }),
      HttpClientRequest.bearerToken(config.appendToken),
      HttpClientRequest.bodyText(body, "application/x-ndjson"),
      client.execute,
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap(HttpClientResponse.schemaBodyJson(IngestResponse))
    );

    yield* Effect.annotateCurrentSpan({
      "tinybird.quarantined_rows": result.quarantined_rows,
      "tinybird.successful_rows": result.successful_rows,
    });

    if (result.quarantined_rows > 0) {
      yield* Effect.logError("Tinybird ingestion quarantined rows", {
        datasource,
        quarantinedRows: result.quarantined_rows,
        requestedRows: rows.length,
        successfulRows: result.successful_rows,
      });

      return yield* new TinybirdRowsQuarantined({
        datasource,
        quarantinedRows: result.quarantined_rows,
        successfulRows: result.successful_rows,
      });
    }

    yield* Effect.logDebug("Tinybird ingestion completed", {
      datasource,
      requestedRows: rows.length,
      successfulRows: result.successful_rows,
    });
  },
  Effect.withLogSpan("tinybird.ingest")
);

export const queryEndpoint = Effect.fn("TinybirdClient.queryEndpoint")(
  function* queryEndpointEffect<S extends Schema.Constraint>(
    config: TinybirdClientConfig,
    endpoint: TinybirdEndpoint,
    params: UrlParams.Input,
    schema: S
  ) {
    yield* Effect.annotateCurrentSpan({
      "tinybird.endpoint": endpoint,
      "tinybird.operation": "query",
    });

    const client = yield* HttpClient.HttpClient;
    const responseSchema = Schema.Struct({
      data: Schema.Array(schema),
    });

    const response = yield* HttpClientRequest.get(
      new URL(`/v0/pipes/${endpoint}.json`, config.baseUrl)
    ).pipe(
      HttpClientRequest.setUrlParams(params),
      HttpClientRequest.bearerToken(config.readToken),
      HttpClientRequest.acceptJson,
      client.execute,
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap(HttpClientResponse.schemaBodyJson(responseSchema))
    );

    yield* Effect.annotateCurrentSpan(
      "tinybird.returned_rows",
      response.data.length
    );
    yield* Effect.logDebug("Tinybird query completed", {
      endpoint,
      returnedRows: response.data.length,
    });

    return response.data;
  },
  Effect.withLogSpan("tinybird.query")
);
