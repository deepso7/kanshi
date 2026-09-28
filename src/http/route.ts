/**
 * Match `segments` against a pattern like `monitors/:id/maintain`; a
 * trailing `*` matches any rest. Returns the `:name` values, or null.
 */
export const matchPattern = (
  pattern: string,
  segments: readonly string[]
): readonly string[] | null => {
  const parts = pattern.split("/");
  const rest = parts.at(-1) === "*";
  const fixed = rest ? parts.slice(0, -1) : parts;
  if (
    segments.length < fixed.length ||
    (!rest && segments.length > fixed.length)
  ) {
    return null;
  }
  const params: string[] = [];
  for (const [index, part] of fixed.entries()) {
    const segment = segments[index] ?? "";
    if (part.startsWith(":")) {
      params.push(segment);
    } else if (part !== segment) {
      return null;
    }
  }
  return params;
};
