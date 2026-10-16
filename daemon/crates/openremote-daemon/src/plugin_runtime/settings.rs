//! The values a user sets for a plugin, kept on this machine only in
//! `<data dir>/plugin-settings/<plugin id>.json`, a file only this user
//! may read (as the API token is). Secrets live there too and leave it in
//! one direction only: to the plugin, when it starts or runs. The API
//! answers whether a secret is set, never what it is, and nothing here is
//! ever logged.

use std::path::{Path, PathBuf};

use openremote_core::{SettingField, SettingKind};
use serde_json::{Map, Value, json};

use super::manifest::check_value;

pub struct SettingsStore {
    dir: PathBuf,
}

impl SettingsStore {
    pub fn new(data_dir: &Path) -> Self {
        Self {
            dir: data_dir.join("plugin-settings"),
        }
    }

    fn path(&self, id: &str) -> PathBuf {
        // A plugin id is letters, digits, '-', '.', '_', '@' and '~' - all
        // fine in a file name on every system.
        self.dir.join(format!("{id}.json"))
    }

    /// The stored values, secrets included. Empty when nothing was set.
    pub fn load(&self, id: &str) -> Map<String, Value> {
        std::fs::read(self.path(id))
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Map<String, Value>>(&bytes).ok())
            .unwrap_or_default()
    }

    pub fn save(&self, id: &str, values: &Map<String, Value>) -> std::io::Result<()> {
        openremote_core::fsx::create_private_dir(&self.dir)?;
        let bytes = serde_json::to_vec_pretty(values).expect("settings serialize");
        openremote_core::fsx::write_private(&self.path(id), &bytes)
    }

    /// A removed plugin's values go with it - its secrets included.
    pub fn forget(&self, id: &str) {
        let _ = std::fs::remove_file(self.path(id));
    }
}

/// The settings as the console reads them: every plain value (what was
/// set, else the default, else null) and, for each secret, only whether
/// it is set.
pub fn view(id: &str, schema: &[SettingField], stored: &Map<String, Value>) -> Value {
    let mut values = Map::new();
    let mut secrets = Map::new();
    for field in schema {
        if field.kind == SettingKind::Secret {
            let set = stored
                .get(&field.key)
                .and_then(Value::as_str)
                .is_some_and(|s| !s.is_empty());
            secrets.insert(
                field.key.clone(),
                Value::String(if set { "set" } else { "unset" }.into()),
            );
        } else {
            values.insert(
                field.key.clone(),
                stored
                    .get(&field.key)
                    .cloned()
                    .or_else(|| field.default.clone())
                    .unwrap_or(Value::Null),
            );
        }
    }
    json!({
        "id": id,
        "schema": schema,
        "values": values,
        "secrets": secrets,
        "missing": missing_required(schema, stored),
    })
}

/// Apply a change: each key present is set, a null puts it back to its
/// default (a secret, to unset). Keys the plugin doesn't declare, and
/// values that don't fit, are refused whole - nothing is half-applied.
pub fn apply(
    schema: &[SettingField],
    stored: &mut Map<String, Value>,
    changes: &Map<String, Value>,
) -> Result<(), String> {
    let mut next = stored.clone();
    for (key, value) in changes {
        let Some(field) = schema.iter().find(|f| &f.key == key) else {
            return Err(format!("the plugin has no setting named {key}"));
        };
        if value.is_null() {
            next.remove(key);
            continue;
        }
        check_value(field, value).map_err(|why| format!("{} {why}", field.label))?;
        next.insert(key.clone(), value.clone());
    }
    *stored = next;
    Ok(())
}

/// What the plugin is handed: every declared value - set, else default -
/// secrets included. Undeclared leftovers (from an older version) stay
/// out.
pub fn effective(schema: &[SettingField], stored: &Map<String, Value>) -> Map<String, Value> {
    let mut out = Map::new();
    for field in schema {
        if let Some(value) = stored.get(&field.key).cloned().or(field.default.clone()) {
            out.insert(field.key.clone(), value);
        }
    }
    out
}

/// The labels of required settings still unset: the plugin doesn't run
/// until they are.
pub fn missing_required(schema: &[SettingField], stored: &Map<String, Value>) -> Vec<String> {
    schema
        .iter()
        .filter(|f| f.required)
        .filter(|f| {
            let value = stored.get(&f.key).or(f.default.as_ref());
            match value {
                None | Some(Value::Null) => true,
                Some(Value::String(s)) => s.is_empty(),
                Some(_) => false,
            }
        })
        .map(|f| f.label.clone())
        .collect()
}
