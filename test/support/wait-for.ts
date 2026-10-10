export const sleep = (ms: number) =>
  new Promise<void>((r) => setTimeout(r, ms));

/** Repite `check` hasta que devuelva algo "truthy" o venza `timeoutMs`. */
export async function waitFor<T>(
  check: () => Promise<T> | T,
  timeoutMs = 8_000,
  everyMs = 100,
): Promise<NonNullable<T>> {
  const until = Date.now() + timeoutMs;
  let last: T;
  do {
    last = await check();
    if (last) return last as NonNullable<T>;
    await sleep(everyMs);
  } while (Date.now() < until);
  throw new Error(
    `waitFor: no se cumplió en ${timeoutMs} ms (último valor: ${JSON.stringify(last!)})`,
  );
}
