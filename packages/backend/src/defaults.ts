/**
 * @module
 * Framework-default budgets applied by adapter layers when the caller
 * doesn't specify their own. See `createBackend` and `fromAiSdk`.
 */

/**
 * Default `maxContext` ceiling when a caller doesn't supply one.
 * Safe floor across major reasoning models as of 2026 — below the
 * 1M-context frontier (Claude 4.6+, GPT-5.4 extended, Gemini 2.0),
 * above the 272K / 200K smaller-window models (GPT-5.4 standard,
 * Gemini 3 Flash).
 */
export const DEFAULT_MAX_CONTEXT = 400_000

/**
 * Default `maxOutput` ceiling when a caller doesn't supply one.
 * Broadest-compatibility output cap: matches Claude Opus 4.7 standard
 * (exactly 32K), clamps under Sonnet 4.6 (64K) and GPT-5.4 (128K),
 * stays within Gemini Flash's 8-32K output range.
 */
export const DEFAULT_MAX_OUTPUT = 32_000
