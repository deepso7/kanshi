/**
 * A tiny HTML templating helper. `html` escapes every interpolated value
 * unless it is already `Html` (the result of another `html` template or of
 * `raw`), so markup composes and data never becomes markup.
 */
export class Html {
  readonly value: string;
  constructor(value: string) {
    this.value = value;
  }
  toString(): string {
    return this.value;
  }
}

/**
 * Anything that may be interpolated. `false`, `null` and `undefined` render
 * nothing (so `cond && html\`...\`` works); arrays render each item.
 */
export type Interpolation =
  | Html
  | string
  | number
  | false
  | null
  | undefined
  | readonly Interpolation[];

const escapes = new Map([
  ['"', "&quot;"],
  ["&", "&amp;"],
  ["'", "&#39;"],
  ["<", "&lt;"],
  [">", "&gt;"],
]);

/** Escape text for use in element content and quoted attribute values. */
export const escapeHtml = (text: string): string =>
  text.replaceAll(/["&'<>]/gu, (char) => escapes.get(char) ?? char);

const isList = (value: Interpolation): value is readonly Interpolation[] =>
  Array.isArray(value);

const render = (value: Interpolation): string => {
  if (value instanceof Html) {
    return value.value;
  }
  if (value === false || value === null || value === undefined) {
    return "";
  }
  if (isList(value)) {
    return value.map(render).join("");
  }
  return escapeHtml(String(value));
};

/** Trusted markup, inserted as is. Never pass user data. */
export const raw = (markup: string): Html => new Html(markup);

export const html = (
  strings: TemplateStringsArray,
  ...values: readonly Interpolation[]
): Html => {
  let out = strings[0] ?? "";
  for (const [index, value] of values.entries()) {
    out += render(value) + (strings[index + 1] ?? "");
  }
  return new Html(out);
};

/** Only http(s) URLs may become links; anything else renders as `#`. */
export const safeHref = (url: string): string => {
  if (!URL.canParse(url)) {
    return "#";
  }
  const { protocol } = new URL(url);
  return protocol === "http:" || protocol === "https:" ? url : "#";
};
