// `useMutation` plus the app's feedback: a success toast and an error
// toast (the API's message as its description). Wraps the shared
// `mutationOptions` from `api/queries.ts` without losing their own
// callbacks (cache seeding and invalidation run first, and are awaited).
import type { UseMutationOptions } from "@tanstack/react-query";
import { useMutation } from "@tanstack/react-query";
import * as Predicate from "effect/Predicate";

import { describeError, isUnauthorized } from "../api/errors.ts";
import { toast } from "../components/ui/toast.tsx";

export interface ToastMessages<TData, TVariables> {
  /**
   * The success toast's title (or a function of the reply and the
   * variables). Omit it for no success toast.
   */
  readonly success?: string | ((data: TData, variables: TVariables) => string);
  /**
   * The error toast's title; its description is the API's message
   * (`describeError`). Default "Could not complete that". `false`: no
   * toast, for errors the page shows itself (a form's field error).
   */
  readonly error?: string | false;
}

/**
 * ```tsx
 * const pause = useToastMutation(updateMonitorMutation, {
 *   success: (_monitor, { patch }) =>
 *     patch.enabled === true ? "Monitor resumed" : "Monitor paused",
 *   error: "Could not update the monitor",
 * });
 * pause.mutate({ id, patch: { enabled: false } });
 * ```
 *
 * A 401 never toasts: the app signs out and shows the login page.
 */
export const useToastMutation = <TData, TVariables, TOnMutateResult>(
  options: UseMutationOptions<TData, Error, TVariables, TOnMutateResult>,
  messages: ToastMessages<TData, TVariables> = {}
) =>
  useMutation({
    ...options,
    onError: (error, variables, onMutateResult, context) => {
      if (messages.error !== false && !isUnauthorized(error)) {
        const view = describeError(error);
        toast.error(messages.error ?? "Could not complete that", {
          description: view.message,
        });
      }
      return options.onError?.(error, variables, onMutateResult, context);
    },
    onSuccess: async (data, variables, onMutateResult, context) => {
      await options.onSuccess?.(data, variables, onMutateResult, context);
      const { success } = messages;
      if (success !== undefined) {
        toast.success(
          Predicate.isString(success) ? success : success(data, variables)
        );
      }
    },
  });
