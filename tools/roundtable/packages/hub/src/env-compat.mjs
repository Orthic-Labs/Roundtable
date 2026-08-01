/**
 * `CITADEL_*` / `ROUNDTABLE_*` env var compatibility shim (Stage 2).
 *
 * Application code reads the `CITADEL_` variable as primary. The deprecated `ROUNDTABLE_`
 * variable is still honored, unchanged, for backward compatibility — with a one-time stderr
 * warning naming the `CITADEL_` replacement so operators know to migrate. Never remove or
 * rename `ROUNDTABLE_*` support; this shim is additive only.
 */

/**
 * Resolves an env var honoring `citadelVar` over the deprecated `deprecatedVar`.
 *
 * Precedence: `citadelVar` if set and non-empty (no warning); else `deprecatedVar` if set and
 * non-empty (emits one deprecation warning to stderr naming `citadelVar`, returns the
 * `deprecatedVar` value unchanged); else `undefined`.
 */
export function resolveEnv(citadelVar, deprecatedVar, env = process.env) {
  const citadelValue = env[citadelVar];
  if (citadelValue !== undefined && citadelValue !== '') return citadelValue;
  const deprecatedValue = env[deprecatedVar];
  if (deprecatedValue !== undefined && deprecatedValue !== '') {
    console.warn(`warning: ${deprecatedVar} is deprecated; set ${citadelVar} instead`);
    return deprecatedValue;
  }
  return undefined;
}
