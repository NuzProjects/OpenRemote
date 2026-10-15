//! The plugin system's foundation (Plugins): the six harnesses are
//! built-in plugins - off hides one from every picker, and they cannot be
//! uninstalled. A plugin installs from a folder, a git repo or an archive
//! in two steps: staged and read first (name, runtime, powers, whether it
//! runs outside a sandbox), installed only on approval.

mod common;

use common::*;
use serde_json::{Value, json};
use std::path::Path;

async fn daemon() -> TestDaemon {
    start_daemon(&[("claude", fixture_agent()), ("codex", fixture_agent())]).await
}

fn write(dir: &Path, files: &[(&str, &str)]) {
    for (path, body) in files {
        let p = dir.join(path);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, body).unwrap();
    }
}

fn toy(version: &str) -> Vec<(String, String)> {
    vec![
        (
            "openremote.json".into(),
            format!(
                r#"{{"api": 1, "name": "toy", "version": "{version}", "runtime": "process", "powers": ["network"]}}"#
            ),
        ),
        (
            ".claude-plugin/plugin.json".into(),
            format!(r#"{{"name": "toy", "version": "{version}"}}"#),
        ),
        ("skills/greet/SKILL.md".into(), "# greet".into()),
    ]
}

fn toy_folder(version: &str) -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    let files = toy(version);
    let refs: Vec<(&str, &str)> = files
        .iter()
        .map(|(a, b)| (a.as_str(), b.as_str()))
        .collect();
    write(dir.path(), &refs);
    dir
}

async fn stage(daemon: &TestDaemon, rid: &str, source: Value) -> Reply {
    call(
        daemon,
        "POST",
        "/plugins/stage",
        Some(json!({"request_id": rid, "source": source})),
    )
    .await
}

async fn install(daemon: &TestDaemon, rid: &str, stage_id: &str) -> Reply {
    call(
        daemon,
        "POST",
        &format!("/plugins/stage/{stage_id}/install"),
        Some(json!({"request_id": rid})),
    )
    .await
}

async fn installed(daemon: &TestDaemon) -> Vec<Value> {
    let list = call(daemon, "GET", "/plugins", None).await;
    list.body["installed"]
        .as_array()
        .cloned()
        .unwrap_or_default()
}

#[tokio::test]
async fn the_harnesses_are_built_in_plugins_and_off_hides_one_from_the_pickers() {
    let daemon = daemon().await;
    let list = call(&daemon, "GET", "/plugins", None).await;
    let ids: Vec<&str> = list.body["builtin"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| p["id"].as_str().unwrap())
        .collect();
    assert!(
        ids.contains(&"claude") && ids.contains(&"codex"),
        "{}",
        list.raw
    );

    let off = call(
        &daemon,
        "POST",
        "/plugins/codex/enabled",
        Some(json!({"request_id": "b-off", "enabled": false})),
    )
    .await;
    assert_eq!(off.status, 200, "{}", off.raw);
    // The pickers read capabilities: codex is there, and off.
    let caps = call(&daemon, "GET", "/capabilities", None).await;
    let codex = caps.body["harnesses"]
        .as_array()
        .unwrap()
        .iter()
        .find(|h| h["id"] == "codex")
        .cloned()
        .unwrap();
    assert_eq!(codex["enabled"], false, "{codex}");
    let claude = caps.body["harnesses"]
        .as_array()
        .unwrap()
        .iter()
        .find(|h| h["id"] == "claude")
        .cloned()
        .unwrap();
    assert_eq!(claude["enabled"], true, "{claude}");

    // Built in: never uninstalled, only off.
    let remove = call(
        &daemon,
        "POST",
        "/plugins/codex/remove",
        Some(json!({"request_id": "b-rm"})),
    )
    .await;
    assert_eq!(remove.status, 409, "{}", remove.raw);

    call(
        &daemon,
        "POST",
        "/plugins/codex/enabled",
        Some(json!({"request_id": "b-on", "enabled": true})),
    )
    .await;
    let caps = call(&daemon, "GET", "/capabilities", None).await;
    assert!(
        caps.body["harnesses"]
            .as_array()
            .unwrap()
            .iter()
            .all(|h| h["enabled"] == true),
        "{}",
        caps.raw
    );
}

#[tokio::test]
async fn a_folder_plugin_is_staged_then_installed_only_on_approval() {
    let daemon = daemon().await;
    let folder = toy_folder("1.0.0");
    let staged = stage(
        &daemon,
        "f-stage",
        json!({"kind": "folder", "path": folder.path()}),
    )
    .await;
    assert_eq!(staged.status, 200, "{}", staged.raw);
    let result = &staged.body["result"];
    let manifest = &result["manifest"];
    assert_eq!(manifest["name"], "toy");
    assert_eq!(manifest["runtime"], "process");
    assert_eq!(manifest["powers"], json!(["run_programs", "network"]));
    assert_eq!(manifest["not_sandboxed"], true);
    assert_eq!(manifest["claude_parts"], json!(["skills"]));
    assert!(result["replaces"].is_null());
    // Staged is not installed.
    assert!(installed(&daemon).await.is_empty());

    let id = result["stage_id"].as_str().unwrap();
    let done = install(&daemon, "f-install", id).await;
    assert_eq!(done.status, 200, "{}", done.raw);
    let list = installed(&daemon).await;
    assert_eq!(list.len(), 1);
    assert_eq!(list[0]["name"], "toy");
    // A direct install is filed under the marketplace name "local".
    assert_eq!(list[0]["id"], "toy@local");
    assert_eq!(list[0]["marketplace"], "local");
    assert_eq!(list[0]["source"]["kind"], "folder");
    assert_eq!(list[0]["scope"], "machine");
    assert_eq!(list[0]["enabled"], true);
    let on_disk = daemon.data_dir().join("plugins").join("local").join("toy");
    assert!(on_disk.join("openremote.json").is_file());
    assert!(
        on_disk
            .join("skills")
            .join("greet")
            .join("SKILL.md")
            .is_file()
    );

    let off = call(
        &daemon,
        "POST",
        "/plugins/toy@local/enabled",
        Some(json!({"request_id": "f-off", "enabled": false})),
    )
    .await;
    assert_eq!(off.status, 200, "{}", off.raw);
    assert_eq!(installed(&daemon).await[0]["enabled"], false);

    let removed = call(
        &daemon,
        "POST",
        "/plugins/toy@local/remove",
        Some(json!({"request_id": "f-rm"})),
    )
    .await;
    assert_eq!(removed.status, 200, "{}", removed.raw);
    assert!(installed(&daemon).await.is_empty());
    assert!(!on_disk.exists());
}

#[tokio::test]
async fn a_git_repo_installs_without_its_history() {
    let daemon = daemon().await;
    let repo = toy_folder("1.0.0");
    let git = |args: &[&str]| {
        let status = std::process::Command::new("git")
            .args(["-c", "user.email=t@example.com", "-c", "user.name=t"])
            .args(args)
            .current_dir(repo.path())
            .output()
            .expect("git runs");
        assert!(
            status.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&status.stderr)
        );
    };
    git(&["init", "--quiet"]);
    git(&["add", "."]);
    git(&["commit", "--quiet", "-m", "toy"]);

    let staged = stage(
        &daemon,
        "g-stage",
        json!({"kind": "git", "url": repo.path().to_string_lossy()}),
    )
    .await;
    assert_eq!(staged.status, 200, "{}", staged.raw);
    let id = staged.body["result"]["stage_id"].as_str().unwrap();
    assert_eq!(install(&daemon, "g-install", id).await.status, 200);
    let list = installed(&daemon).await;
    assert_eq!(list[0]["source"]["kind"], "git");
    let on_disk = daemon.data_dir().join("plugins").join("local").join("toy");
    assert!(on_disk.join("openremote.json").is_file());
    assert!(!on_disk.join(".git").exists(), "the history stays behind");
}

#[tokio::test]
async fn a_zip_installs_with_its_top_folder_unwrapped() {
    let daemon = daemon().await;
    let archive_dir = tempfile::tempdir().unwrap();
    let archive = archive_dir.path().join("toy.zip");
    {
        let file = std::fs::File::create(&archive).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        for (path, body) in toy("1.0.0") {
            zip.start_file(
                format!("toy-1.0.0/{path}"),
                zip::write::SimpleFileOptions::default(),
            )
            .unwrap();
            std::io::Write::write_all(&mut zip, body.as_bytes()).unwrap();
        }
        zip.finish().unwrap();
    }
    let staged = stage(
        &daemon,
        "z-stage",
        json!({"kind": "archive", "location": archive.to_string_lossy()}),
    )
    .await;
    assert_eq!(staged.status, 200, "{}", staged.raw);
    assert_eq!(staged.body["result"]["manifest"]["name"], "toy");
    let id = staged.body["result"]["stage_id"].as_str().unwrap();
    assert_eq!(install(&daemon, "z-install", id).await.status, 200);
    assert!(
        daemon
            .data_dir()
            .join("plugins/local/toy/openremote.json")
            .is_file()
    );
}

#[tokio::test]
async fn a_wrong_plugin_is_refused_with_its_reason() {
    let daemon = daemon().await;
    let dir = tempfile::tempdir().unwrap();
    write(
        dir.path(),
        &[(
            "openremote.json",
            r#"{"api": 2, "name": "toy", "runtime": "js"}"#,
        )],
    );
    let staged = stage(
        &daemon,
        "w-stage",
        json!({"kind": "folder", "path": dir.path()}),
    )
    .await;
    assert_eq!(staged.status, 400, "{}", staged.raw);
    assert!(
        staged.body["error"].as_str().unwrap().contains("api 2"),
        "{}",
        staged.raw
    );

    let missing = stage(
        &daemon,
        "w-missing",
        json!({"kind": "folder", "path": dir.path().join("nowhere")}),
    )
    .await;
    assert_eq!(missing.status, 400, "{}", missing.raw);
}

#[tokio::test]
async fn installing_a_name_again_replaces_it_and_a_cancelled_stage_is_gone() {
    let daemon = daemon().await;
    let v1 = toy_folder("1.0.0");
    let s1 = stage(
        &daemon,
        "u-s1",
        json!({"kind": "folder", "path": v1.path()}),
    )
    .await;
    install(
        &daemon,
        "u-i1",
        s1.body["result"]["stage_id"].as_str().unwrap(),
    )
    .await;
    let first = installed(&daemon).await[0].clone();

    let v2 = toy_folder("2.0.0");
    let s2 = stage(
        &daemon,
        "u-s2",
        json!({"kind": "folder", "path": v2.path()}),
    )
    .await;
    assert_eq!(s2.body["result"]["replaces"], "1.0.0", "{}", s2.raw);
    install(
        &daemon,
        "u-i2",
        s2.body["result"]["stage_id"].as_str().unwrap(),
    )
    .await;
    let list = installed(&daemon).await;
    assert_eq!(list.len(), 1);
    assert_eq!(list[0]["version"], "2.0.0");
    assert_eq!(list[0]["installed_at"], first["installed_at"]);

    let s3 = stage(
        &daemon,
        "u-s3",
        json!({"kind": "folder", "path": v1.path()}),
    )
    .await;
    let id = s3.body["result"]["stage_id"].as_str().unwrap().to_string();
    let cancelled = call(
        &daemon,
        "POST",
        &format!("/plugins/stage/{id}/cancel"),
        Some(json!({"request_id": "u-c"})),
    )
    .await;
    assert_eq!(cancelled.status, 200, "{}", cancelled.raw);
    assert_eq!(install(&daemon, "u-i3", &id).await.status, 404);
    assert_eq!(installed(&daemon).await[0]["version"], "2.0.0");
}
