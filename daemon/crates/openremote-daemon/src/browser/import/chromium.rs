//! Chrome, Edge, Brave and the other Chromium browsers: bookmarks from the
//! profile's `Bookmarks` file (JSON), history from its `History` database.

use std::collections::{HashMap, HashSet};
use std::path::Path;

use serde_json::Value;

use super::sqlite::Database;
use super::{Ctx, Scratch, folder_name, friendly, read_text, web};
use crate::browser::store::{Bookmark, Visit};

/// Chromium counts microseconds from 1601; the unix epoch is this many
/// milliseconds later.
const EPOCH_MS: i64 = 11_644_473_600_000;

fn from_chromium(micros: i64) -> i64 {
    micros / 1000 - EPOCH_MS
}

pub fn bookmarks(file: &Path, ctx: &Ctx) -> Result<Vec<Bookmark>, String> {
    let text = read_text(file).map_err(|e| friendly(&e, ctx.short, "bookmarks"))?;
    let json: Value = serde_json::from_str(&text)
        .map_err(|_| format!("{}'s bookmarks file is damaged", ctx.short))?;
    let roots = json
        .get("roots")
        .ok_or_else(|| format!("{}'s bookmarks file has no bookmarks in it", ctx.short))?;
    let mut out = Vec::new();
    let mut place = Place::default();
    // The bar and Other bookmarks join the one folder; the phone's go in a
    // folder of their own inside it.
    for (key, below) in [
        ("bookmark_bar", None),
        ("other", None),
        ("synced", Some("Mobile bookmarks")),
    ] {
        let Some(root) = roots.get(key) else {
            continue;
        };
        let mut path: Vec<String> = below.map(String::from).into_iter().collect();
        walk(root, &mut path, ctx, &mut place, &mut out);
    }
    Ok(out)
}

#[derive(Default)]
struct Place {
    next: HashMap<String, f64>,
}

fn walk(node: &Value, path: &mut Vec<String>, ctx: &Ctx, place: &mut Place, out: &mut Vec<Bookmark>) {
    let Some(children) = node.get("children").and_then(Value::as_array) else {
        return;
    };
    for child in children {
        if out.len() >= ctx.max_bookmarks {
            return;
        }
        let name = child.get("name").and_then(Value::as_str).unwrap_or("");
        match child.get("type").and_then(Value::as_str) {
            Some("folder") => {
                path.push(name.to_string());
                walk(child, path, ctx, place, out);
                path.pop();
            }
            Some("url") => {
                let Some(url) = child.get("url").and_then(Value::as_str).filter(|u| web(u)) else {
                    continue;
                };
                let folder = folder_name(ctx.short, path);
                let position = place.next.entry(folder.clone()).or_insert(0.0);
                *position += 1.0;
                let key = child
                    .get("guid")
                    .and_then(Value::as_str)
                    .map(String::from)
                    .unwrap_or_else(|| super::digest(&format!("{folder}\n{url}")));
                out.push(Bookmark {
                    id: format!("imp-{}-{key}", ctx.slug),
                    url: url.to_string(),
                    title: name.to_string(),
                    folder,
                    position: *position,
                    added: child
                        .get("date_added")
                        .and_then(Value::as_str)
                        .and_then(|s| s.parse::<i64>().ok())
                        .filter(|&t| t > 0)
                        .map_or(ctx.now, from_chromium),
                });
            }
            _ => {}
        }
    }
}

pub fn history(file: &Path, ctx: &Ctx, scratch: &Scratch) -> Result<Vec<Visit>, String> {
    let copy = scratch
        .copy(file, "History")
        .map_err(|e| friendly(&e, ctx.short, "history"))?;
    read_history(&copy, ctx).map_err(|e| format!("{}'s history couldn't be read: {e}", ctx.short))
}

fn read_history(file: &Path, ctx: &Ctx) -> Result<Vec<Visit>, super::sqlite::Error> {
    let mut db = Database::open(file)?;
    let visits = db.table("visits")?;
    let mut recent: Vec<(i64, i64, i64)> = Vec::new();
    db.scan(&visits, &["id", "url", "visit_time", "transition"], |_, row| {
        let (Some(id), Some(url), Some(at)) = (row[0].int(), row[1].int(), row[2].int()) else {
            return true;
        };
        let at = from_chromium(at);
        // Pages inside pages (frames) are not visits.
        let core = row[3].int().unwrap_or(0) & 0xff;
        if at >= ctx.horizon && at <= ctx.now + 86_400_000 && core != 3 && core != 4 {
            recent.push((id, url, at));
        }
        true
    })?;
    recent.sort_by(|a, b| b.2.cmp(&a.2));
    recent.truncate(ctx.max_visits);
    let wanted: HashSet<i64> = recent.iter().map(|r| r.1).collect();
    let urls = db.table("urls")?;
    let mut pages: HashMap<i64, (String, String)> = HashMap::new();
    db.scan(&urls, &["id", "url", "title", "hidden"], |_, row| {
        let Some(id) = row[0].int().filter(|id| wanted.contains(id)) else {
            return true;
        };
        if let (Some(url), false) = (row[1].text().filter(|u| web(u)), row[3].int() == Some(1)) {
            pages.insert(id, (url.to_string(), row[2].text().unwrap_or("").to_string()));
        }
        true
    })?;
    Ok(recent
        .into_iter()
        .filter_map(|(id, url, at)| {
            let (url, title) = pages.get(&url)?.clone();
            Some(Visit {
                id: format!("imp-{}-v{id}", ctx.slug),
                url,
                title,
                at,
            })
        })
        .collect())
}
