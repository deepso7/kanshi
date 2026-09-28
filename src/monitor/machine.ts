import type {
  MonitorConfig,
  MonitorState,
  MonitorStatus,
} from "../domain/monitor.ts";

export type Transition = "down" | "none" | "up";

type Thresholds = Pick<MonitorConfig, "failureThreshold" | "successThreshold">;
type Streaks = Pick<MonitorState, "failureStreak" | "status" | "successStreak">;

/**
 * The status state machine. Feed it only results that count toward status
 * (successes, confirmed failures). Down after `failureThreshold` failures in
 * a row, up after `successThreshold` successes in a row. `transition` is
 * `down` when the monitor enters `down`, `up` when it leaves `down` for
 * `up`; `unknown -> up` is not a transition.
 */
export const evaluate = <S extends Streaks>(
  state: S,
  config: Thresholds,
  result: { readonly ok: boolean }
): { readonly state: S; readonly transition: Transition } => {
  if (result.ok) {
    const successStreak = state.successStreak + 1;
    const status: MonitorStatus =
      state.status !== "up" && successStreak >= config.successThreshold
        ? "up"
        : state.status;
    return {
      state: { ...state, failureStreak: 0, status, successStreak },
      transition: state.status === "down" && status === "up" ? "up" : "none",
    };
  }
  const failureStreak = state.failureStreak + 1;
  const status: MonitorStatus =
    state.status !== "down" && failureStreak >= config.failureThreshold
      ? "down"
      : state.status;
  return {
    state: { ...state, failureStreak, status, successStreak: 0 },
    transition: state.status !== "down" && status === "down" ? "down" : "none",
  };
};
