//! MCP server catalog. The marketplace was an early list of launch
//! commands that were never installed for real - it is empty until a
//! catalog is facts. An MCP server is written by hand; a key never
//! crosses this API.

use serde::Serialize;

#[derive(Clone, Serialize, Debug)]
pub struct CatalogEntry {
    pub id: String,
    pub name: String,
    pub detail: String,
    pub needs_key: bool,
    /// The launch command, as that machine would start it.
    pub command: String,
}

/// No curated catalog. MCP servers are written by hand.
pub fn marketplace() -> Vec<CatalogEntry> {
    Vec::new()
}

pub fn catalog_entry(id: &str) -> Option<CatalogEntry> {
    marketplace().into_iter().find(|e| e.id == id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_catalog_is_empty() {
        assert!(marketplace().is_empty());
        assert!(catalog_entry("github").is_none());
    }
}
