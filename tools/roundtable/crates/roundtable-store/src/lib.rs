use rusqlite::{Connection, Result};

pub const MIGRATION: &str = include_str!("../migrations/0001_initial.sql");

pub fn open(path: &str) -> Result<Connection> {
    let connection = Connection::open(path)?;
    connection.execute_batch(MIGRATION)?;
    Ok(connection)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn migration_creates_exact_schema() {
        let connection = open(":memory:").unwrap();
        let count: i64 = connection.query_row("SELECT count(*) FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'", [], |row| row.get(0)).unwrap();
        assert_eq!(count, 11);
    }
}
