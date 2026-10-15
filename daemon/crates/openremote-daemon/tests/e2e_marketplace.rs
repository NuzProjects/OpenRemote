//! Plugin marketplaces: Claude Code's own catalog format, read as it is.
//! A marketplace is added from a folder, a git repo or a marketplace.json
//! link; Discover lists its entries with what each asks for when that is
//! knowable before install; an entry installs through the same review as a
//! direct install, as `name@marketplace`, beside a direct install of the
//! same name. Every source type a catalog can name is fetched - a folder
//! in the catalog, a git repo (pinned or following a branch), a subfolder
//! of a repo, an archive (checked against its sha256), an npm package
//! (straight from the registry, checked against its integrity digest) and
//! a command (run only as approved, and again at each claude chat start).
//! Claude chats load the plugins left on with `--plugin-dir`.

mod common;

use std::path::{Path, PathBuf};

use common::*;
use serde_json::{Value, json};
use sha2::Digest;

async fn daemon() -> TestDaemon {
    start_daemon(&[("claude", fixture_agent())]).await
}

fn write(dir: &Path, files: &[(&str, &str)]) {
    for (path, body) in files {
        let p = dir.join(path);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, body).unwrap();
    }
}

/// A plugin folder's files: OpenRemote's part and Claude's, one skill.
fn toy(version: &str, powers: &[&str]) -> Vec<(String, String)> {
    vec![
        (
            "openremote.json".into(),
            json!({"api": 1, "name": "toy", "version": version, "runtime": "process", "powers": powers})
                .to_string(),
        ),
        (
            ".claude-plugin/plugin.json".into(),
            json!({"name": "toy", "version": version}).to_string(),
        ),
        ("skills/greet/SKILL.md".into(), "# greet".into()),
    ]
}

fn write_owned(dir: &Path, files: &[(String, String)]) {
    let refs: Vec<(&str, &str)> = files
        .iter()
        .map(|(a, b)| (a.as_str(), b.as_str()))
        .collect();
    write(dir, &refs);
}

/// A marketplace folder: its catalog, and the plugin folders it holds.
fn catalog(dir: &Path, name: &str, plugins: Value) {
    write(
        dir,
        &[(
            ".claude-plugin/marketplace.json",
            &json!({"name": name, "owner": {"name": "Test"}, "plugins": plugins}).to_string(),
        )],
    );
}

async fn post(daemon: &TestDaemon, path: &str, rid: &str, body: Value) -> Reply {
    let mut body = body;
    body["request_id"] = json!(rid);
    call(daemon, "POST", path, Some(body)).await
}

async fn add(daemon: &TestDaemon, rid: &str, source: &str) -> Reply {
    post(daemon, "/marketplaces", rid, json!({"source": source})).await
}

async fn stage_entry(
    daemon: &TestDaemon,
    rid: &str,
    marketplace: &str,
    plugin: &str,
    approve: Option<&str>,
) -> Reply {
    let mut source = json!({"kind": "marketplace", "marketplace": marketplace, "plugin": plugin});
    if let Some(command) = approve {
        source["approve_command"] = json!(command);
    }
    post(daemon, "/plugins/stage", rid, json!({"source": source})).await
}

async fn install(daemon: &TestDaemon, rid: &str, staged: &Reply) -> Reply {
    assert_eq!(staged.status, 200, "{}", staged.raw);
    let id = staged.body["result"]["stage_id"]
        .as_str()
        .unwrap_or_else(|| panic!("staged: {}", staged.raw));
    let done = post(
        daemon,
        &format!("/plugins/stage/{id}/install"),
        rid,
        json!({}),
    )
    .await;
    assert_eq!(done.status, 200, "{}", done.raw);
    done
}

async fn installed(daemon: &TestDaemon) -> Vec<Value> {
    call(daemon, "GET", "/plugins", None).await.body["installed"]
        .as_array()
        .cloned()
        .unwrap_or_default()
}

async fn entries(daemon: &TestDaemon) -> Vec<Value> {
    let reply = call(daemon, "GET", "/marketplaces/catalog", None).await;
    assert_eq!(reply.status, 200, "{}", reply.raw);
    reply.body["entries"]
        .as_array()
        .cloned()
        .unwrap_or_default()
}

fn find<'a>(list: &'a [Value], id: &str) -> &'a Value {
    list.iter()
        .find(|e| e["id"] == id)
        .unwrap_or_else(|| panic!("no {id} in {list:?}"))
}

fn file_url(path: &Path) -> String {
    let p = path.to_string_lossy().replace('\\', "/");
    if p.starts_with('/') {
        format!("file://{p}")
    } else {
        format!("file:///{p}")
    }
}

fn git(dir: &Path, args: &[&str]) -> String {
    let out = std::process::Command::new("git")
        .args(["-c", "user.email=t@example.com", "-c", "user.name=t"])
        .args(args)
        .current_dir(dir)
        .output()
        .expect("git runs");
    assert!(
        out.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

/// A repository with one commit of `files`. It answers a fetch by commit,
/// as GitHub does.
fn repo(files: &[(String, String)]) -> (tempfile::TempDir, String) {
    let dir = tempfile::tempdir().unwrap();
    write_owned(dir.path(), files);
    git(dir.path(), &["init", "--quiet"]);
    git(
        dir.path(),
        &["config", "uploadpack.allowAnySHA1InWant", "true"],
    );
    git(dir.path(), &["add", "."]);
    git(dir.path(), &["commit", "--quiet", "-m", "plugin"]);
    let sha = git(dir.path(), &["rev-parse", "HEAD"]);
    (dir, sha)
}

#[tokio::test]
async fn a_folder_marketplace_lists_its_plugins_and_installs_one_beside_a_direct_install() {
    let daemon = daemon().await;
    let market = tempfile::tempdir().unwrap();
    catalog(
        market.path(),
        "team-tools",
        json!([
            {"name": "toy", "source": "./plugins/toy", "description": "from the catalog"},
            {"name": "skills-only", "source": "./plugins/bare", "strict": false, "skills": ["./greet"]},
        ]),
    );
    write_owned(
        &market.path().join("plugins/toy"),
        &toy("1.0.0", &["network"]),
    );
    write(market.path(), &[("plugins/bare/greet/SKILL.md", "# greet")]);

    let added = add(&daemon, "m-add", &market.path().to_string_lossy()).await;
    assert_eq!(added.status, 200, "{}", added.raw);
    assert_eq!(added.body["result"]["name"], "team-tools");
    assert_eq!(added.body["result"]["plugin_count"], 2);

    // The two marketplaces a machine starts with are there too.
    let names: Vec<String> = call(&daemon, "GET", "/marketplaces", None)
        .await
        .body
        .as_array()
        .unwrap()
        .iter()
        .map(|m| m["name"].as_str().unwrap().to_string())
        .collect();
    for name in ["openremote", "claude-plugins-official", "team-tools"] {
        assert!(names.iter().any(|n| n == name), "{names:?}");
    }

    // Discover reads a catalog folder's plugin as Claude Code does: its own
    // manifest says exactly what it asks for.
    let list = entries(&daemon).await;
    let toy_entry = find(&list, "toy@team-tools");
    assert_eq!(toy_entry["version"], "1.0.0");
    assert_eq!(toy_entry["powers"], json!(["run_programs", "network"]));
    assert_eq!(toy_entry["not_sandboxed"], true);
    assert_eq!(toy_entry["installable"], true);
    assert!(toy_entry["installed"].is_null());

    let staged = stage_entry(&daemon, "m-s1", "team-tools", "toy", None).await;
    assert_eq!(
        staged.body["result"]["id"], "toy@team-tools",
        "{}",
        staged.raw
    );
    install(&daemon, "m-i1", &staged).await;
    let on_disk = daemon.data_dir().join("plugins/team-tools/toy");
    assert!(on_disk.join("openremote.json").is_file());

    // The same plugin installed directly sits beside it, as toy@local.
    let direct = post(
        &daemon,
        "/plugins/stage",
        "m-s2",
        json!({"source": {"kind": "folder", "path": market.path().join("plugins/toy")}}),
    )
    .await;
    assert_eq!(direct.body["result"]["id"], "toy@local", "{}", direct.raw);
    install(&daemon, "m-i2", &direct).await;
    let ids: Vec<String> = installed(&daemon)
        .await
        .iter()
        .map(|p| p["id"].as_str().unwrap().to_string())
        .collect();
    assert!(ids.contains(&"toy@team-tools".to_string()), "{ids:?}");
    assert!(ids.contains(&"toy@local".to_string()), "{ids:?}");
    let from_market = installed(&daemon)
        .await
        .into_iter()
        .find(|p| p["id"] == "toy@team-tools")
        .unwrap();
    assert_eq!(from_market["source"]["kind"], "marketplace");
    assert_eq!(from_market["source"]["marketplace"], "team-tools");

    // With no plugin.json the entry is the manifest - written, so claude
    // reads the folder as one plugin.
    let bare = stage_entry(&daemon, "m-s3", "team-tools", "skills-only", None).await;
    install(&daemon, "m-i3", &bare).await;
    let manifest: Value = serde_json::from_slice(
        &std::fs::read(
            daemon
                .data_dir()
                .join("plugins/team-tools/skills-only/.claude-plugin/plugin.json"),
        )
        .unwrap(),
    )
    .unwrap();
    assert_eq!(manifest["name"], "skills-only");
    assert_eq!(manifest["skills"], json!(["./greet"]));
    assert!(manifest.get("source").is_none());

    let list = entries(&daemon).await;
    assert_eq!(
        find(&list, "toy@team-tools")["installed"]["version"],
        "1.0.0"
    );
    assert_eq!(find(&list, "toy@team-tools")["update"], false);
}

#[tokio::test]
async fn claude_chats_load_the_plugins_left_on_and_not_the_ones_turned_off() {
    let daemon = daemon().await;
    let plugins = tempfile::tempdir().unwrap();
    for name in ["docs", "notes"] {
        write(
            &plugins.path().join(name),
            &[
                (
                    ".claude-plugin/plugin.json",
                    &json!({"name": name}).to_string(),
                ),
                ("skills/x/SKILL.md", "# x"),
            ],
        );
        let staged = post(
            &daemon,
            "/plugins/stage",
            &format!("c-s-{name}"),
            json!({"source": {"kind": "folder", "path": plugins.path().join(name)}}),
        )
        .await;
        install(&daemon, &format!("c-i-{name}"), &staged).await;
    }
    let off = post(
        &daemon,
        "/plugins/notes@local/enabled",
        "c-off",
        json!({"enabled": false}),
    )
    .await;
    assert_eq!(off.status, 200, "{}", off.raw);

    let ws = workspace(Some("plain"));
    let created = post(
        &daemon,
        "/sessions",
        "c-create",
        json!({"harness": "claude", "workspace": ws.path()}),
    )
    .await;
    assert_eq!(created.status, 201, "{}", created.raw);
    let id = created.body["id"].as_str().unwrap().to_string();
    post(
        &daemon,
        &format!("/sessions/{id}/prompts"),
        "c-p1",
        json!({"text": "hi"}),
    )
    .await;
    until_count(
        &daemon,
        &format!("/sessions/{id}/events"),
        "turn.completed",
        1,
    )
    .await;

    let argv = std::fs::read_to_string(ws.path().join("fixture-claude-argv")).unwrap();
    let docs = daemon.data_dir().join("plugins").join("local").join("docs");
    let notes = daemon
        .data_dir()
        .join("plugins")
        .join("local")
        .join("notes");
    assert!(
        argv.contains(&format!("--plugin-dir {}", docs.display())),
        "{argv}"
    );
    assert!(!argv.contains(&notes.display().to_string()), "{argv}");
}

#[tokio::test]
async fn git_entries_install_at_their_pinned_commit_and_from_a_subfolder() {
    let daemon = daemon().await;
    let (solo, solo_sha) = repo(&[(
        ".claude-plugin/plugin.json".into(),
        json!({"name": "solo"}).to_string(),
    )]);
    let (mono, _) = repo(&[
        ("README.md".into(), "a monorepo".into()),
        (
            "plugins/fmt/.claude-plugin/plugin.json".into(),
            json!({"name": "fmt", "version": "0.3.0"}).to_string(),
        ),
        ("plugins/fmt/commands/fmt.md".into(), "format".into()),
    ]);
    let market = tempfile::tempdir().unwrap();
    catalog(
        market.path(),
        "git-tools",
        json!([
            {"name": "solo", "source": {"source": "url", "url": file_url(solo.path()), "sha": solo_sha}},
            {"name": "fmt", "source": {"source": "git-subdir", "url": file_url(mono.path()), "path": "plugins/fmt"}},
        ]),
    );
    assert_eq!(
        add(&daemon, "g-add", &market.path().to_string_lossy())
            .await
            .status,
        200
    );

    let solo_staged = stage_entry(&daemon, "g-s1", "git-tools", "solo", None).await;
    install(&daemon, "g-i1", &solo_staged).await;
    let fmt_staged = stage_entry(&daemon, "g-s2", "git-tools", "fmt", None).await;
    assert_eq!(fmt_staged.body["result"]["manifest"]["version"], "0.3.0");
    install(&daemon, "g-i2", &fmt_staged).await;

    let list = installed(&daemon).await;
    let solo_record = list.iter().find(|p| p["id"] == "solo@git-tools").unwrap();
    assert_eq!(solo_record["resolved"], solo_sha.as_str());
    let fmt_dir = daemon.data_dir().join("plugins/git-tools/fmt");
    assert!(fmt_dir.join("commands/fmt.md").is_file());
    // Only the subfolder: the rest of the repository stayed behind.
    assert!(!fmt_dir.join("README.md").exists());
    assert!(!fmt_dir.join(".git").exists());
}

fn zip_of(files: &[(String, String)], top: &str) -> Vec<u8> {
    let mut bytes = Vec::new();
    {
        let mut zip = zip::ZipWriter::new(std::io::Cursor::new(&mut bytes));
        for (path, body) in files {
            zip.start_file(
                format!("{top}/{path}"),
                zip::write::SimpleFileOptions::default(),
            )
            .unwrap();
            std::io::Write::write_all(&mut zip, body.as_bytes()).unwrap();
        }
        zip.finish().unwrap();
    }
    bytes
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

#[tokio::test]
async fn an_archive_entry_is_refused_when_it_does_not_match_its_sha256() {
    let daemon = daemon().await;
    let dir = tempfile::tempdir().unwrap();
    let bytes = zip_of(&toy("1.0.0", &[]), "toy-1.0.0");
    let archive = dir.path().join("toy.zip");
    std::fs::write(&archive, &bytes).unwrap();
    let digest = hex(&sha2::Sha256::digest(&bytes));
    let market = tempfile::tempdir().unwrap();
    catalog(
        market.path(),
        "zips",
        json!([
            {"name": "toy", "source": {"source": "archive", "url": archive, "sha256": digest}},
            {"name": "changed", "source": {"source": "archive", "url": archive, "sha256": "0".repeat(64)}},
        ]),
    );
    add(&daemon, "a-add", &market.path().to_string_lossy()).await;

    let good = stage_entry(&daemon, "a-s1", "zips", "toy", None).await;
    install(&daemon, "a-i1", &good).await;
    let record = installed(&daemon).await;
    assert_eq!(record[0]["resolved"], digest.as_str());

    let bad = stage_entry(&daemon, "a-s2", "zips", "changed", None).await;
    assert_eq!(bad.status, 400, "{}", bad.raw);
    assert!(bad.raw.contains("sha256"), "{}", bad.raw);
}

/// A registry stand-in on a listener the test bound (so the content can
/// name its own address): package metadata at `/<name>` (scoped names
/// with `%2f`), and plain files - tarballs, a bare marketplace.json.
async fn serve(
    listener: tokio::net::TcpListener,
    packages: Vec<(String, Value)>,
    files: Vec<(String, Vec<u8>)>,
) {
    use axum::extract::Path as AxumPath;
    use axum::response::IntoResponse;
    let packages = std::sync::Arc::new(packages);
    let files = std::sync::Arc::new(files);
    let app = axum::Router::new().route(
        "/{*path}",
        axum::routing::get(move |AxumPath(path): AxumPath<String>| {
            let packages = packages.clone();
            let files = files.clone();
            async move {
                let path = path.replace("%2f", "/").replace("%2F", "/");
                if let Some((_, meta)) = packages.iter().find(|(name, _)| *name == path) {
                    return axum::Json(meta.clone()).into_response();
                }
                if let Some((_, bytes)) = files.iter().find(|(name, _)| *name == path) {
                    return bytes.clone().into_response();
                }
                axum::http::StatusCode::NOT_FOUND.into_response()
            }
        }),
    );
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
}

fn tgz_of(files: &[(&str, &str)]) -> Vec<u8> {
    let mut bytes = Vec::new();
    {
        let gz = flate2::write::GzEncoder::new(&mut bytes, flate2::Compression::default());
        let mut tar = tar::Builder::new(gz);
        for (path, body) in files {
            let mut header = tar::Header::new_gnu();
            header.set_size(body.len() as u64);
            header.set_mode(0o644);
            header.set_cksum();
            tar.append_data(&mut header, format!("package/{path}"), body.as_bytes())
                .unwrap();
        }
        tar.into_inner().unwrap().finish().unwrap();
    }
    bytes
}

fn sri(bytes: &[u8]) -> String {
    use base64::Engine;
    format!(
        "sha512-{}",
        base64::engine::general_purpose::STANDARD.encode(sha2::Sha512::digest(bytes))
    )
}

#[tokio::test]
async fn an_npm_entry_installs_straight_from_the_registry_and_a_bare_link_lists() {
    let daemon = daemon().await;
    let good = tgz_of(&[
        (
            ".claude-plugin/plugin.json",
            &json!({"name": "notes", "version": "1.2.0"}).to_string(),
        ),
        ("skills/x/SKILL.md", "# x"),
    ]);
    let other = tgz_of(&[(".claude-plugin/plugin.json", r#"{"name": "evil"}"#)]);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let meta = |tarball: &str, integrity: &str| {
        json!({
            "name": "x",
            "dist-tags": {"latest": "2.0.0"},
            "versions": {
                "1.0.0": {"dist": {"tarball": format!("{base}/t/{tarball}"), "integrity": integrity}},
                "1.2.0": {"dist": {"tarball": format!("{base}/t/{tarball}"), "integrity": integrity}},
                "2.0.0": {"dist": {"tarball": format!("{base}/t/none.tgz"), "integrity": "sha512-x"}},
            }
        })
    };
    let catalog_json = json!({
        "name": "linked",
        "owner": {"name": "Test"},
        "plugins": [
            {"name": "inside", "source": "./plugins/inside"},
            {"name": "notes", "source": {"source": "npm", "package": "@acme/notes", "version": "^1.0.0", "registry": base}},
            {"name": "tampered", "source": {"source": "npm", "package": "@acme/tampered", "version": "1.2.0", "registry": base}},
        ]
    });
    let packages = vec![
        (
            "@acme/notes".to_string(),
            meta("notes-1.2.0.tgz", &sri(&good)),
        ),
        (
            "@acme/tampered".to_string(),
            meta("tampered.tgz", &sri(&good)),
        ),
    ];
    let files = vec![
        ("t/notes-1.2.0.tgz".to_string(), good.clone()),
        ("t/tampered.tgz".to_string(), other),
        (
            "marketplace.json".to_string(),
            catalog_json.to_string().into_bytes(),
        ),
    ];
    serve(listener, packages, files).await;

    // A bare marketplace.json link: its folder entries can't be fetched,
    // its npm entries can.
    let added = add(&daemon, "n-add", &format!("{base}/marketplace.json")).await;
    assert_eq!(added.status, 200, "{}", added.raw);
    assert_eq!(added.body["result"]["source"]["kind"], "url");
    let list = entries(&daemon).await;
    assert_eq!(find(&list, "inside@linked")["installable"], false);
    assert_eq!(find(&list, "notes@linked")["installable"], true);

    let staged = stage_entry(&daemon, "n-s1", "linked", "notes", None).await;
    assert_eq!(staged.body["result"]["manifest"]["version"], "1.2.0");
    install(&daemon, "n-i1", &staged).await;
    let record = installed(&daemon).await;
    assert_eq!(record[0]["resolved"], "1.2.0");
    assert!(
        daemon
            .data_dir()
            .join("plugins/linked/notes/skills/x/SKILL.md")
            .is_file()
    );

    // A tarball that is not what the registry's digest says is refused.
    let tampered = stage_entry(&daemon, "n-s2", "linked", "tampered", None).await;
    assert_eq!(tampered.status, 400, "{}", tampered.raw);
    assert!(tampered.raw.contains("integrity"), "{}", tampered.raw);
}

/// The command that prints `folder`: the shell's own "print this file".
fn print_command(pointer: &Path) -> String {
    if cfg!(windows) {
        format!("type {}", pointer.display())
    } else {
        format!("cat {}", pointer.display())
    }
}

#[tokio::test]
async fn a_command_entry_runs_only_as_approved_and_again_at_each_claude_chat() {
    let daemon = daemon().await;
    let generated = tempfile::tempdir().unwrap();
    let folder: PathBuf = generated.path().join("gen");
    write(
        &folder,
        &[
            (".claude-plugin/plugin.json", r#"{"name": "gen"}"#),
            ("skills/a/SKILL.md", "# a"),
        ],
    );
    let pointer = generated.path().join("where.txt");
    std::fs::write(&pointer, folder.to_string_lossy().as_bytes()).unwrap();
    let command = print_command(&pointer);
    let market = tempfile::tempdir().unwrap();
    catalog(
        market.path(),
        "generated",
        json!([{"name": "gen", "source": {"source": "command", "command": command, "timeout": 30}}]),
    );
    add(&daemon, "x-add", &market.path().to_string_lossy()).await;
    let list = entries(&daemon).await;
    assert_eq!(
        find(&list, "gen@generated")["powers"],
        json!(["run_programs"])
    );

    // Nothing runs until the user has seen the exact command.
    let first = stage_entry(&daemon, "x-s1", "generated", "gen", None).await;
    assert_eq!(first.status, 200, "{}", first.raw);
    assert_eq!(first.body["result"]["needs_command"]["command"], command);
    assert!(first.body["result"]["stage_id"].is_null());
    let wrong = stage_entry(&daemon, "x-s2", "generated", "gen", Some("echo other")).await;
    assert!(wrong.body["result"]["needs_command"].is_object());

    let approved = stage_entry(&daemon, "x-s3", "generated", "gen", Some(&command)).await;
    install(&daemon, "x-i1", &approved).await;
    let record = installed(&daemon).await;
    assert_eq!(record[0]["command"]["command"], command);
    let copy = daemon.data_dir().join("plugins/generated/gen");
    assert!(copy.join("skills/a/SKILL.md").is_file());

    // The tool's output changed: the next claude chat start takes it.
    write(&folder, &[("skills/b/SKILL.md", "# b")]);
    let ws = workspace(Some("plain"));
    let created = post(
        &daemon,
        "/sessions",
        "x-c1",
        json!({"harness": "claude", "workspace": ws.path()}),
    )
    .await;
    assert_eq!(created.status, 201, "{}", created.raw);
    assert!(copy.join("skills/b/SKILL.md").is_file());

    // The command fails: the chat starts with the last copy and says so.
    std::fs::write(&pointer, b"").unwrap();
    let created = post(
        &daemon,
        "/sessions",
        "x-c2",
        json!({"harness": "claude", "workspace": ws.path()}),
    )
    .await;
    assert_eq!(created.status, 201, "{}", created.raw);
    let id = created.body["id"].as_str().unwrap().to_string();
    let seen = until_count(&daemon, &format!("/sessions/{id}/events"), "note.added", 1).await;
    let note = seen
        .iter()
        .find(|(_, e)| e["type"] == "note.added" || e["kind"] == "note.added")
        .map(|(_, e)| e.to_string())
        .unwrap_or_default();
    assert!(note.contains("gen@generated"), "{note}");
    assert!(copy.join("skills/b/SKILL.md").is_file());
}

#[tokio::test]
async fn discover_sees_an_update_and_the_review_calls_out_new_powers() {
    let daemon = daemon().await;
    let market = tempfile::tempdir().unwrap();
    catalog(
        market.path(),
        "team-tools",
        json!([{"name": "toy", "source": "./plugins/toy"}]),
    );
    let folder = market.path().join("plugins/toy");
    write_owned(&folder, &toy("1.0.0", &["network"]));
    add(&daemon, "u-add", &market.path().to_string_lossy()).await;
    let staged = stage_entry(&daemon, "u-s1", "team-tools", "toy", None).await;
    install(&daemon, "u-i1", &staged).await;
    assert_eq!(
        find(&entries(&daemon).await, "toy@team-tools")["update"],
        false
    );

    write_owned(&folder, &toy("2.0.0", &["network", "microphone"]));
    let list = entries(&daemon).await;
    assert_eq!(find(&list, "toy@team-tools")["update"], true);
    assert_eq!(find(&list, "toy@team-tools")["version"], "2.0.0");

    let again = stage_entry(&daemon, "u-s2", "team-tools", "toy", None).await;
    assert_eq!(again.body["result"]["replaces"], "1.0.0", "{}", again.raw);
    assert_eq!(again.body["result"]["new_powers"], json!(["microphone"]));
    // Turned off before the update: stays off after it.
    post(
        &daemon,
        "/plugins/toy@team-tools/enabled",
        "u-off",
        json!({"enabled": false}),
    )
    .await;
    install(&daemon, "u-i2", &again).await;
    let record = installed(&daemon).await;
    assert_eq!(record[0]["version"], "2.0.0");
    assert_eq!(record[0]["enabled"], false);
}

#[tokio::test]
async fn marketplaces_turn_off_and_go_while_their_plugins_stay() {
    let daemon = daemon().await;
    let market = tempfile::tempdir().unwrap();
    catalog(
        market.path(),
        "team-tools",
        json!([{"name": "toy", "source": "./plugins/toy"}]),
    );
    write_owned(&market.path().join("plugins/toy"), &toy("1.0.0", &[]));
    let path = market.path().to_string_lossy().to_string();
    add(&daemon, "r-add", &path).await;
    let again = add(&daemon, "r-add2", &path).await;
    assert_eq!(again.status, 409, "{}", again.raw);
    let staged = stage_entry(&daemon, "r-s1", "team-tools", "toy", None).await;
    install(&daemon, "r-i1", &staged).await;

    let off = post(
        &daemon,
        "/marketplaces/team-tools/enabled",
        "r-off",
        json!({"enabled": false}),
    )
    .await;
    assert_eq!(off.status, 200, "{}", off.raw);
    assert!(
        entries(&daemon)
            .await
            .iter()
            .all(|e| e["marketplace"] != "team-tools")
    );

    let removed = post(
        &daemon,
        "/marketplaces/team-tools/remove",
        "r-rm",
        json!({}),
    )
    .await;
    assert_eq!(removed.status, 200, "{}", removed.raw);
    assert_eq!(installed(&daemon).await[0]["id"], "toy@team-tools");

    // OpenRemote's own can be turned off, never removed.
    let official = post(
        &daemon,
        "/marketplaces/openremote/remove",
        "r-rm2",
        json!({}),
    )
    .await;
    assert_eq!(official.status, 409, "{}", official.raw);
    let official_off = post(
        &daemon,
        "/marketplaces/openremote/enabled",
        "r-off2",
        json!({"enabled": false}),
    )
    .await;
    assert_eq!(official_off.status, 200, "{}", official_off.raw);

    // A catalog that calls itself by OpenRemote's name from elsewhere.
    let impostor = tempfile::tempdir().unwrap();
    catalog(impostor.path(), "openremote", json!([]));
    let refused = add(&daemon, "r-imp", &impostor.path().to_string_lossy()).await;
    assert_eq!(refused.status, 400, "{}", refused.raw);
    assert!(refused.raw.contains("belongs to"), "{}", refused.raw);

    // A refresh that finds the catalog renamed keeps the old copy and says so.
    let other = tempfile::tempdir().unwrap();
    catalog(other.path(), "renamer", json!([]));
    add(&daemon, "r-add3", &other.path().to_string_lossy()).await;
    catalog(other.path(), "renamed", json!([]));
    let refreshed = post(&daemon, "/marketplaces/renamer/refresh", "r-ref", json!({})).await;
    assert_eq!(refreshed.status, 200, "{}", refreshed.raw);
    assert!(
        refreshed.body["result"]["error"]
            .as_str()
            .unwrap_or_default()
            .contains("renamed"),
        "{}",
        refreshed.raw
    );
}
