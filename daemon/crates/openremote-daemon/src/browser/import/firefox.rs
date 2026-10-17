//! Firefox: bookmarks and history both live in the profile's
//! `places.sqlite`, a write-ahead-log database that Firefox keeps open
//! while it runs (its newest changes sit in the `-wal` file beside it).

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use super::sqlite::Database;
use super::{Ctx, Scratch, folder_name, friendly, read_text, web};
use crate::browser::store::{Bookmark, Visit};

/// The profiles Firefox lists in `profiles.ini` (in the folder that holds
/// it), the default first: (directory name, shown name, directory).
pub fn profiles(root: &Path) -> Vec<(String, String, PathBuf)> {
    let Ok(text) = read_text(&root.join("profiles.ini")) else {
        return Vec::new();
    };
    let mut found: Vec<(String, String, PathBuf, bool)> = Vec::new();
    let mut section = String::new();
    let (mut name, mut path, mut relative, mut default) = (String::new(), String::new(), true, false);
    let mut installs: Vec<String> = Vec::new();
    let mut flush = |section: &str, name: &str, path: &str, relative: bool, default: bool| {
        if section.starts_with("Profile") && !path.is_empty() {
            let dir = if relative {
                root.join(path)
            } else {
                PathBuf::from(path)
            };
            let id = dir
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default();
            let shown = if name.is_empty() { id.clone() } else { name.to_string() };
            found.push((id, shown, dir, default));
        }
    };
    for line in text.lines().map(str::trim) {
        if let Some(head) = line.strip_prefix('[').and_then(|l| l.strip_suffix(']')) {
            flush(&section, &name, &path, relative, default);
            section = head.to_string();
            (name, path, relative, default) = (String::new(), String::new(), true, false);
        } else if let Some((key, value)) = line.split_once('=') {
            match key.trim() {
                "Name" => name = value.trim().to_string(),
                "Path" if section.starts_with("Install") => {
                    installs.push(value.trim().to_string());
                }
                "Path" => path = value.trim().to_string(),
                "IsRelative" => relative = value.trim() != "0",
                "Default" => default = value.trim() == "1",
                _ => {}
            }
        }
    }
    flush(&section, &name, &path, relative, default);
    // The profile an install runs by default comes first, then the ones
    // `profiles.ini` marks, then the rest.
    found.sort_by_key(|(_, _, dir, marked)| {
        let by_install = installs.iter().any(|p| dir.ends_with(p));
        (!by_install, !marked)
    });
    found
        .into_iter()
        .map(|(id, name, dir, _)| (id, name, dir))
        .collect()
}

pub fn bookmarks(file: &Path, ctx: &Ctx, scratch: &Scratch) -> Result<Vec<Bookmark>, String> {
    let copy = scratch
        .copy(file, "places.sqlite")
        .map_err(|e| friendly(&e, ctx.short, "bookmarks"))?;
    read_bookmarks(&copy, ctx).map_err(|e| format!("{}'s bookmarks couldn't be read: {e}", ctx.short))
}

struct Node {
    id: i64,
    kind: i64,
    url_id: Option<i64>,
    parent: i64,
    position: i64,
    title: String,
    added: i64,
    guid: String,
}

fn read_bookmarks(file: &Path, ctx: &Ctx) -> Result<Vec<Bookmark>, super::sqlite::Error> {
    let mut db = Database::open(file)?;
    let table = db.table("moz_bookmarks")?;
    let mut nodes: Vec<Node> = Vec::new();
    db.scan(
        &table,
        &["id", "type", "fk", "parent", "position", "title", "dateAdded", "guid"],
        |_, row| {
            if let (Some(id), Some(kind), Some(parent)) = (row[0].int(), row[1].int(), row[3].int()) {
                nodes.push(Node {
                    id,
                    kind,
                    url_id: row[2].int(),
                    parent,
                    position: row[4].int().unwrap_or(0),
                    title: row[5].text().unwrap_or("").to_string(),
                    added: row[6].int().unwrap_or(0),
                    guid: row[7].text().unwrap_or("").to_string(),
                });
            }
            true
        },
    )?;
    let wanted: HashSet<i64> = nodes.iter().filter(|n| n.kind == 1).filter_map(|n| n.url_id).collect();
    let places = db.table("moz_places")?;
    let mut urls: HashMap<i64, String> = HashMap::new();
    db.scan(&places, &["id", "url"], |_, row| {
        if let (Some(id), Some(url)) = (row[0].int().filter(|id| wanted.contains(id)), row[1].text()) {
            if web(url) {
                urls.insert(id, url.to_string());
            }
        }
        true
    })?;
    let mut children: HashMap<i64, Vec<&Node>> = HashMap::new();
    for node in &nodes {
        children.entry(node.parent).or_default().push(node);
    }
    for list in children.values_mut() {
        list.sort_by_key(|n| (n.position, n.id));
    }
    let mut out = Vec::new();
    // The root's children are the menu, toolbar, unfiled and mobile
    // folders (and the tag folder, which holds no bookmarks of its own).
    for top in children.get(&1).into_iter().flatten() {
        let mut path = Vec::new();
        match top.guid.as_str() {
            "tags________" => continue,
            "mobile______" => path.push("Mobile bookmarks".to_string()),
            _ => {}
        }
        let mut place = HashMap::new();
        descend(top.id, &mut path, &children, &urls, ctx, &mut place, &mut out);
    }
    Ok(out)
}

fn descend(
    parent: i64,
    path: &mut Vec<String>,
    children: &HashMap<i64, Vec<&Node>>,
    urls: &HashMap<i64, String>,
    ctx: &Ctx,
    place: &mut HashMap<String, f64>,
    out: &mut Vec<Bookmark>,
) {
    for node in children.get(&parent).into_iter().flatten() {
        if out.len() >= ctx.max_bookmarks {
            return;
        }
        match node.kind {
            2 => {
                path.push(node.title.clone());
                descend(node.id, path, children, urls, ctx, place, out);
                path.pop();
            }
            1 => {
                let Some(url) = node.url_id.and_then(|id| urls.get(&id)) else {
                    continue;
                };
                let folder = folder_name(ctx.short, path);
                let position = place.entry(folder.clone()).or_insert(0.0);
                *position += 1.0;
                out.push(Bookmark {
                    id: format!("imp-{}-{}", ctx.slug, node.guid),
                    url: url.clone(),
                    title: node.title.clone(),
                    folder,
                    position: *position,
                    added: if node.added > 0 { node.added / 1000 } else { ctx.now },
                });
            }
            _ => {}
        }
    }
}

pub fn history(file: &Path, ctx: &Ctx, scratch: &Scratch) -> Result<Vec<Visit>, String> {
    let copy = scratch
        .copy(file, "places.sqlite")
        .map_err(|e| friendly(&e, ctx.short, "history"))?;
    read_history(&copy, ctx).map_err(|e| format!("{}'s history couldn't be read: {e}", ctx.short))
}

fn read_history(file: &Path, ctx: &Ctx) -> Result<Vec<Visit>, super::sqlite::Error> {
    let mut db = Database::open(file)?;
    let visits = db.table("moz_historyvisits")?;
    let mut recent: Vec<(i64, i64, i64)> = Vec::new();
    db.scan(&visits, &["id", "place_id", "visit_date", "visit_type"], |_, row| {
        let (Some(id), Some(place), Some(at)) = (row[0].int(), row[1].int(), row[2].int()) else {
            return true;
        };
        let at = at / 1000;
        // Embedded and framed loads are not visits.
        let kind = row[3].int().unwrap_or(1);
        if at >= ctx.horizon && at <= ctx.now + 86_400_000 && kind != 4 && kind != 8 {
            recent.push((id, place, at));
        }
        true
    })?;
    recent.sort_by(|a, b| b.2.cmp(&a.2));
    recent.truncate(ctx.max_visits);
    let wanted: HashSet<i64> = recent.iter().map(|r| r.1).collect();
    let places = db.table("moz_places")?;
    let mut pages: HashMap<i64, (String, String)> = HashMap::new();
    db.scan(&places, &["id", "url", "title", "hidden"], |_, row| {
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
        .filter_map(|(id, place, at)| {
            let (url, title) = pages.get(&place)?.clone();
            Some(Visit {
                id: format!("imp-{}-v{id}", ctx.slug),
                url,
                title,
                at,
            })
        })
        .collect())
}
