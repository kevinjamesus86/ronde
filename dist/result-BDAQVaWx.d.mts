//#region packages/core/src/result.d.ts
/**
 * @module
 * Discriminated result type with `ok()` and `err()` constructors.
 *
 * @example
 * ```ts
 * import { ok, err } from "@ronde/core/result"
 *
 * fetchWeather(city).then(ok).catch(err)
 * ```
 */
type Result<D = unknown> = {
  ok: true;
  data: D;
} | {
  ok: false;
  error: string;
  data?: D;
};
declare function ok<D>(data: D): Result<D> & {
  ok: true;
};
/** Construct a failure result. Accepts a string or Error. */
declare function err(error: string | Error): Result<never> & {
  ok: false;
};
declare function err<D>(error: string | Error, data: D): Result<D> & {
  ok: false;
};
declare function isOk<D>(r: Result<D>): r is Result<D> & {
  ok: true;
};
//#endregion
export { ok as i, err as n, isOk as r, Result as t };
//# sourceMappingURL=result-BDAQVaWx.d.mts.map