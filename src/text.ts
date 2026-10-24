/** Small text helpers shared by every module that bounds or scrubs what it shows. */

/** `text` cut to at most `max` characters, ending in `…` when it was cut. */
export function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** `text` with every occurrence of `secret` (e.g. an installation token) replaced by `[token]`. */
export function scrubSecret(text: string, secret: string | undefined): string {
  return secret ? text.split(secret).join("[token]") : text;
}

/** An error's message, for logs and messages. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
