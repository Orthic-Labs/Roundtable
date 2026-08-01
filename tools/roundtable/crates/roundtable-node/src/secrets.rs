//! Bearer token retrieval - env first, file fallback. Never logs the token.
use std::path::Path;
use crate::NodeResult;

#[derive(Debug, Clone)]
pub struct BearerToken(String);

impl BearerToken {
    pub fn load(env_var: &str, path: &Path) -> NodeResult<Self> {
        if let Ok(value) = std::env::var(env_var) {
            let trimmed = value.trim();
            if !trimmed.is_empty() {
                return Ok(BearerToken(trimmed.to_string()));
            }
        }
        if path.exists() {
            let bytes = std::fs::read(path)?;
            let trimmed = String::from_utf8_lossy(&bytes).trim().to_string();
            if !trimmed.is_empty() {
                return Ok(BearerToken(trimmed));
            }
        }
        Err(crate::NodeError::Provider(format!(
            "bearer token not found (env={} path={})",
            env_var, path.display()
        )))
    }

    /// Same as [`Self::load`], but checks `citadel_env` (primary) before the deprecated
    /// `deprecated_env`, via [`crate::env_compat::resolve`] — which emits the one-time stderr
    /// deprecation warning when the deprecated var is what actually supplied the value. Falls
    /// back to the file at `path` exactly as `load` does when neither env var is set.
    pub fn load_aliased(citadel_env: &str, deprecated_env: &str, path: &Path) -> NodeResult<Self> {
        if let Some(value) = crate::env_compat::resolve(citadel_env, deprecated_env) {
            let trimmed = value.trim();
            if !trimmed.is_empty() {
                return Ok(BearerToken(trimmed.to_string()));
            }
        }
        if path.exists() {
            let bytes = std::fs::read(path)?;
            let trimmed = String::from_utf8_lossy(&bytes).trim().to_string();
            if !trimmed.is_empty() {
                return Ok(BearerToken(trimmed));
            }
        }
        Err(crate::NodeError::Provider(format!(
            "bearer token not found (env={} [deprecated: {}] path={})",
            citadel_env, deprecated_env, path.display()
        )))
    }

    pub fn from_string(value: impl Into<String>) -> Self {
        BearerToken(value.into())
    }

    pub fn expose(&self) -> &str {
        &self.0
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn loads_from_file_when_env_missing() {
        let dir = tempdir().unwrap();
        let p = dir.path().join("token");
        std::fs::write(&p, "  test-token-value  ").unwrap();
        let tok = BearerToken::load("__ROUNDTABLE_NONEXISTENT__", &p).unwrap();
        assert_eq!(tok.expose(), "test-token-value");
    }

    #[test]
    fn errors_when_neither_env_nor_file() {
        let dir = tempdir().unwrap();
        let p = dir.path().join("missing");
        let r = BearerToken::load("__ROUNDTABLE_NONEXISTENT__", &p);
        assert!(r.is_err());
    }

    #[test]
    fn load_aliased_falls_back_to_file_when_neither_env_set() {
        let dir = tempdir().unwrap();
        let p = dir.path().join("token");
        std::fs::write(&p, "  aliased-file-value  ").unwrap();
        let tok = BearerToken::load_aliased(
            "__CITADEL_NONEXISTENT__",
            "__ROUNDTABLE_NONEXISTENT__",
            &p,
        )
        .unwrap();
        assert_eq!(tok.expose(), "aliased-file-value");
    }
}
