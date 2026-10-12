/**
 * `search.keyword_statement_timeout_ms` (#6495): the per-statement bound the
 * Postgres engine sets (`statement_timeout`, transaction-local) around every
 * keyword, keyword-page, keyword-count, title and CJK search statement.
 * Integer milliseconds, default 8000, range 1000..60000; `config set` refuses
 * other values and a stored value outside the range reads as the default.
 *
 * The bound is an operator mitigation, never a request parameter: a remote
 * caller cannot widen it, and the cap keeps a broad keyword query from
 * holding a backend for minutes. It is resolved once per engine connection
 * (the file plane at connect, then the DB plane on the first keyword
 * statement), so `gbrain config set` takes effect on the next connection:
 * the next CLI command, or a restart of `gbrain serve` / the workers. It
 * mitigates #6495 (a brain whose commonest terms cannot be ranked within the
 * bound) by letting the operator trade latency for coverage; ranking cost
 * stays proportional to the matching corpus, so a longer bound buys time,
 * not a faster statement. `countKeywordPages` keeps its own narrower
 * `timeoutMs` when a caller passes one.
 *
 * Postgres only: PGLite runs these statements with no statement timeout.
 */
export const KEYWORD_STATEMENT_TIMEOUT_KEY = 'search.keyword_statement_timeout_ms';
export const KEYWORD_STATEMENT_TIMEOUT_DEFAULT_MS = 8000;
export const KEYWORD_STATEMENT_TIMEOUT_MIN_MS = 1000;
export const KEYWORD_STATEMENT_TIMEOUT_MAX_MS = 60_000;

/** The configured milliseconds when `raw` is an integer in range, else undefined. */
export function keywordStatementTimeoutMs(raw: unknown): number | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  const n = typeof raw === 'string' ? Number(raw.trim()) : Number(raw);
  return Number.isInteger(n) && n >= KEYWORD_STATEMENT_TIMEOUT_MIN_MS && n <= KEYWORD_STATEMENT_TIMEOUT_MAX_MS ? n : undefined;
}

/** File plane, then DB plane, then the default. */
export function resolveKeywordStatementTimeoutMs(fileValue: unknown, dbValue: unknown): number {
  return keywordStatementTimeoutMs(fileValue) ?? keywordStatementTimeoutMs(dbValue) ?? KEYWORD_STATEMENT_TIMEOUT_DEFAULT_MS;
}

/** `config set` refusal text, or null when the value is valid. */
export function keywordStatementTimeoutValueProblem(value: string): string | null {
  return keywordStatementTimeoutMs(value) !== undefined
    ? null
    : `${KEYWORD_STATEMENT_TIMEOUT_KEY} must be an integer number of milliseconds from ${KEYWORD_STATEMENT_TIMEOUT_MIN_MS} to ${KEYWORD_STATEMENT_TIMEOUT_MAX_MS} (got '${value}'). Nothing was written.`;
}

/**
 * The `statement_timeout` setting value (`<ms>ms`) for one engine connection:
 * the file plane's value when set, else the DB plane's. A config table that
 * cannot be read yet (a fresh brain before its schema) yields the default.
 */
export async function loadKeywordStatementTimeout(
  reader: { getConfig(key: string): Promise<string | null | undefined> },
  fileValue: unknown,
): Promise<string> {
  const fileMs = keywordStatementTimeoutMs(fileValue);
  if (fileMs !== undefined) return `${fileMs}ms`;
  const dbValue = await reader.getConfig(KEYWORD_STATEMENT_TIMEOUT_KEY).catch(() => undefined);
  return `${resolveKeywordStatementTimeoutMs(undefined, dbValue)}ms`;
}
