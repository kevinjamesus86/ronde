import { n as CompletionError, r as CompletionErrorKind } from "./completion-D7rwko-L.mjs";

//#region packages/backend/src/errors.d.ts
declare function classifyError(statusCode: number | null, message: string): CompletionErrorKind;
/**
 * Wrap a raw SDK error into a CompletionError, extracting status from
 * common SDK shapes (`status`, `statusCode`, numeric `code`) and
 * preferring nested `error.message` over the outer message.
 */
declare function wrapSdkError(err: unknown): CompletionError;
//#endregion
export { wrapSdkError as n, classifyError as t };
//# sourceMappingURL=errors-DWGCsqPV.d.mts.map