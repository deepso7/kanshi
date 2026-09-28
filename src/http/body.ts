/** Dashboard forms are a handful of short fields; anything bigger is refused. */
export const maxFormBytes = 64 * 1024;

/**
 * How much of a rejected body is read and dropped before the rest is
 * cancelled. Reading it at all keeps proxies (the local dev gateway among
 * them) from resetting the connection when we answer early; the cap keeps
 * a large upload from tying up the isolate.
 */
export const maxDiscardBytes = 1024 * 1024;

const declaredLength = (headers: Headers): number | null => {
  const value = headers.get("content-length");
  if (value === null || !/^\d+$/u.test(value.trim())) {
    return null;
  }
  return Number(value);
};

/**
 * Read and drop `body` chunk by chunk, never holding more than one chunk.
 * Stops after `limit` bytes and cancels the rest. Never throws.
 */
export const discardBody = async (
  body: ReadableStream<Uint8Array> | null,
  limit = maxDiscardBytes
): Promise<void> => {
  if (body === null) {
    return;
  }
  try {
    const reader = body.getReader();
    let size = 0;
    while (size <= limit) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- chunks must be read in order
      const { done, value } = await reader.read();
      if (done) {
        return;
      }
      size += value.byteLength;
    }
    await reader.cancel().catch(() => null);
  } catch {
    // A broken or already-read body has nothing left to drain.
  }
};

export type FormBody =
  | { readonly _tag: "Form"; readonly fields: [string, string][] }
  | { readonly _tag: "TooLarge" };

/**
 * Parse an `application/x-www-form-urlencoded` body of at most `limit`
 * bytes. A bigger body (declared or actual) is drained with `discardBody`
 * and reported as `TooLarge`; an unreadable one parses as no fields.
 */
export const readFormBody = async (
  request: Request,
  limit = maxFormBytes
): Promise<FormBody> => {
  const { body } = request;
  if (body === null) {
    return { _tag: "Form", fields: [] };
  }
  const declared = declaredLength(request.headers);
  if (declared !== null && declared > limit) {
    await discardBody(body);
    return { _tag: "TooLarge" };
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    const reader = body.getReader();
    while (size <= limit) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- chunks must be read in order
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      size += value.byteLength;
      chunks.push(value);
    }
    if (size > limit) {
      reader.releaseLock();
      await discardBody(body);
      return { _tag: "TooLarge" };
    }
  } catch {
    return { _tag: "Form", fields: [] };
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const text = new TextDecoder().decode(bytes);
  return { _tag: "Form", fields: [...new URLSearchParams(text)] };
};
