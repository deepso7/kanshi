// Phase 1 spike: one Worker hosting both DO classes. Throwaway code.
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

import { Monitor, MonitorLive } from "./monitor.ts";
import { Registry, RegistryLive } from "./registry.ts";

export default class SpikeWorker extends Cloudflare.Worker<SpikeWorker>()(
  "KanshiSpike",
  {
    main: import.meta.url,
  },
  Effect.gen(function* SpikeWorkerInit() {
    const monitors = yield* Monitor;
    const registries = yield* Registry;

    return {
      fetch: Effect.gen(function* fetch() {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const url = new URL(request.url, "http://internal");
        const parts = url.pathname.split("/").filter(Boolean);

        if (parts[0] === "registry") {
          const registry = registries.getByName("registry");
          return yield* HttpServerResponse.json({
            rows: yield* registry.list(),
            whoami: yield* registry.whoami(),
          });
        }

        if (parts[0] === "monitor" && parts[1] !== undefined) {
          const [, id, action] = parts;
          const monitor = monitors.getByName(id);
          if (request.method === "POST" && action === "configure") {
            const interval = Number(url.searchParams.get("interval") ?? "0");
            return yield* HttpServerResponse.json(
              yield* monitor.configure(id, interval)
            );
          }
          if (request.method === "POST" && action === "arm") {
            const delay = Number(url.searchParams.get("delay") ?? "0");
            return yield* HttpServerResponse.json({
              alarmAt: yield* monitor.arm(delay),
            });
          }
          if (request.method === "POST" && action === "flaky") {
            const failures = Number(url.searchParams.get("failures") ?? "2");
            return yield* HttpServerResponse.json({
              alarmAt: yield* monitor.armFlaky(1000, failures),
            });
          }
          if (request.method === "POST" && action === "stop") {
            yield* monitor.stop();
            return yield* HttpServerResponse.json({ ok: true });
          }
          if (request.method === "POST" && action === "txfail") {
            return yield* HttpServerResponse.json(yield* monitor.txFail());
          }
          if (action === "registry") {
            return yield* HttpServerResponse.json({
              fromMonitor: yield* monitor.askRegistry(),
            });
          }
          if (action === undefined) {
            return yield* HttpServerResponse.json(yield* monitor.status());
          }
        }

        return HttpServerResponse.text("Not Found", { status: 404 });
      }).pipe(Effect.orDie),
    };
  }).pipe(Effect.provide(MonitorLive.pipe(Layer.provideMerge(RegistryLive))))
) {}
