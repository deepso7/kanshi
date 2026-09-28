import * as Result from "effect/Result";

/**
 * An expected-status spec is a comma-separated list of exact codes (`200`)
 * and classes (`2xx`), for example `2xx`, `200` or `200,204,3xx`. It is
 * stored in its canonical form: lower case, no spaces, no duplicates.
 */
export type ExpectedStatusSpec = string;

export const defaultExpectedStatus: ExpectedStatusSpec = "2xx";

const exactCode = /^[1-5]\d\d$/u;
const statusClass = /^[1-5]xx$/u;

export const parseExpectedStatus = (
  input: number | string
): Result.Result<ExpectedStatusSpec, string> => {
  const tokens = String(input)
    .toLowerCase()
    .split(",")
    .map((token) => token.trim());
  if (tokens.length === 0 || tokens.some((token) => token.length === 0)) {
    return Result.fail(`invalid expected status "${String(input)}"`);
  }
  const invalid = tokens.find(
    (token) => !exactCode.test(token) && !statusClass.test(token)
  );
  if (invalid !== undefined) {
    return Result.fail(
      `invalid expected status "${invalid}": use a code like 200 or a class like 2xx`
    );
  }
  return Result.succeed([...new Set(tokens)].join(","));
};

/** Whether `status` satisfies a canonical spec. */
export const matchesExpectedStatus = (
  spec: ExpectedStatusSpec,
  status: number
): boolean =>
  spec
    .split(",")
    .some((token) =>
      token.endsWith("xx")
        ? Math.floor(status / 100) === Number(token[0])
        : Number(token) === status
    );
