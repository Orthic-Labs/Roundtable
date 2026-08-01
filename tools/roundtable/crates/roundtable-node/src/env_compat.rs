//! `CITADEL_*` / `ROUNDTABLE_*` env var compatibility shim (Stage 2).
//!
//! Application code reads the `CITADEL_` variable as primary. The deprecated `ROUNDTABLE_`
//! variable is still honored, unchanged, for backward compatibility — with a one-time stderr
//! warning naming the `CITADEL_` replacement so operators know to migrate. Never remove or
//! rename `ROUNDTABLE_*` support; this shim is additive only.

/// Resolves an env var honoring `citadel_var` over the deprecated `deprecated_var`.
///
/// Precedence: `citadel_var` if set and non-empty (no warning); else `deprecated_var` if set and
/// non-empty (emits one deprecation warning to stderr naming `citadel_var`, returns the
/// `deprecated_var` value unchanged); else `None`.
pub fn resolve(citadel_var: &str, deprecated_var: &str) -> Option<String> {
    if let Ok(value) = std::env::var(citadel_var) {
        if !value.trim().is_empty() {
            return Some(value);
        }
    }
    if let Ok(value) = std::env::var(deprecated_var) {
        if !value.trim().is_empty() {
            eprintln!(
                "warning: {deprecated_var} is deprecated; set {citadel_var} instead"
            );
            return Some(value);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    // std::env::set_var mutates global process state, so tests that touch env vars must not run
    // concurrently with each other or they will observe each other's values.
    static ENV_LOCK: Mutex<()> = Mutex::new(());

    #[test]
    fn prefers_citadel_when_both_set() {
        let _guard = ENV_LOCK.lock().unwrap();
        std::env::set_var("__ENV_COMPAT_CITADEL__", "citadel-value");
        std::env::set_var("__ENV_COMPAT_ROUNDTABLE__", "roundtable-value");
        let result = resolve("__ENV_COMPAT_CITADEL__", "__ENV_COMPAT_ROUNDTABLE__");
        std::env::remove_var("__ENV_COMPAT_CITADEL__");
        std::env::remove_var("__ENV_COMPAT_ROUNDTABLE__");
        assert_eq!(result, Some("citadel-value".to_string()));
    }

    #[test]
    fn falls_back_to_deprecated_when_citadel_unset() {
        let _guard = ENV_LOCK.lock().unwrap();
        std::env::remove_var("__ENV_COMPAT_CITADEL_2__");
        std::env::set_var("__ENV_COMPAT_ROUNDTABLE_2__", "roundtable-value");
        let result = resolve("__ENV_COMPAT_CITADEL_2__", "__ENV_COMPAT_ROUNDTABLE_2__");
        std::env::remove_var("__ENV_COMPAT_ROUNDTABLE_2__");
        assert_eq!(result, Some("roundtable-value".to_string()));
    }

    #[test]
    fn none_when_neither_set() {
        let _guard = ENV_LOCK.lock().unwrap();
        std::env::remove_var("__ENV_COMPAT_CITADEL_3__");
        std::env::remove_var("__ENV_COMPAT_ROUNDTABLE_3__");
        let result = resolve("__ENV_COMPAT_CITADEL_3__", "__ENV_COMPAT_ROUNDTABLE_3__");
        assert_eq!(result, None);
    }
}
