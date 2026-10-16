//! WASM plugins: agent tools compiled to WebAssembly, run inside the daemon
//! on wasmi, a small pure-Rust interpreter. A module is sandboxed: it sees
//! its own memory and the host functions its powers grant - nothing else.
//! Every call runs on a fresh instance (no state carries between calls or
//! chats), under a fuel limit (CPU) and a memory limit, so a plugin can't
//! hang or swell the daemon.
//!
//! The contract (docs/plugins/protocol.md, "WASM plugins"):
//! - the module exports `memory`, `or_alloc(len: i32) -> i32` and
//!   `or_call(ptr: i32, len: i32) -> i64`;
//! - OpenRemote writes the call - `{"tool", "arguments", "settings",
//!   "chat"}` as JSON - into memory `or_alloc` gave it and calls
//!   `or_call`, which answers `(ptr << 32) | len` of its result: an MCP
//!   tool result (`{"content": [...], "isError": bool}`) as JSON;
//! - imports come from the module `openremote`: `log(ptr, len)` always;
//!   `http(ptr, len) -> i32` and `take(ptr, len) -> i32` only with the
//!   network power.

use std::collections::HashMap;
use std::net::IpAddr;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::{Duration, SystemTime};

use serde_json::{Value, json};
use wasmi::{
    Caller, Config, Engine, Extern, Linker, Module, Store, StoreLimits, StoreLimitsBuilder,
};

/// Instructions a call may run - a few seconds of work at most.
const FUEL: u64 = 2_000_000_000;
/// The most memory one call's instance may hold.
const MEMORY: usize = 64 * 1024 * 1024;
/// A call's input and output are capped here.
const MAX_IO: usize = 16 * 1024 * 1024;
/// Requests one call may make, each with its own time limit.
const MAX_REQUESTS: u32 = 16;
const REQUEST_TIME: Duration = Duration::from_secs(30);
/// A module is refused past this size.
const MAX_MODULE: u64 = 32 * 1024 * 1024;
/// Calls running at once: each takes a blocking thread.
const PARALLEL: usize = 4;

/// The imports a module may name, and the power each needs.
const IMPORTS: &[(&str, Option<openremote_core::PluginPower>)] = &[
    ("log", None),
    ("http", Some(openremote_core::PluginPower::Network)),
    ("take", Some(openremote_core::PluginPower::Network)),
];

struct Host {
    limits: StoreLimits,
    plugin: String,
    requests_left: u32,
    /// The last host answer, waiting for the module to `take` it.
    held: Vec<u8>,
    http: openremote_cloud::https::Http,
    runtime: tokio::runtime::Handle,
}

/// Compiled modules, by file and when it last changed.
pub struct WasmHost {
    engine: Engine,
    modules: StdMutex<HashMap<PathBuf, (Option<SystemTime>, Module)>>,
    parallel: Arc<tokio::sync::Semaphore>,
}

impl Default for WasmHost {
    fn default() -> Self {
        let mut config = Config::default();
        config.consume_fuel(true);
        Self {
            engine: Engine::new(&config),
            modules: StdMutex::new(HashMap::new()),
            parallel: Arc::new(tokio::sync::Semaphore::new(PARALLEL)),
        }
    }
}

impl WasmHost {
    fn module(&self, path: &Path) -> Result<Module, String> {
        let modified = std::fs::metadata(path).and_then(|m| m.modified()).ok();
        if let Some((seen, module)) = self.modules.lock().ok().and_then(|m| m.get(path).cloned()) {
            if seen == modified {
                return Ok(module);
            }
        }
        let module = compile(&self.engine, path)?;
        if let Ok(mut modules) = self.modules.lock() {
            modules.insert(path.to_path_buf(), (modified, module.clone()));
        }
        Ok(module)
    }

    /// Run one tool call: `input` is the call as the module reads it.
    /// Always answers an MCP tool result - a failure is an error result
    /// the agent reads.
    pub async fn call(&self, plugin: &str, path: &Path, network: bool, input: Value) -> Value {
        let module = match self.module(path) {
            Ok(module) => module,
            Err(e) => return error_result(&e),
        };
        let Ok(_turn) = Arc::clone(&self.parallel).acquire_owned().await else {
            return error_result("OpenRemote is stopping");
        };
        let engine = self.engine.clone();
        let plugin = plugin.to_string();
        let runtime = tokio::runtime::Handle::current();
        let run = tokio::task::spawn_blocking(move || {
            run(&engine, &module, &plugin, network, &input, runtime)
        });
        match run.await {
            Ok(Ok(result)) => result,
            Ok(Err(e)) => error_result(&e),
            Err(_) => error_result("the plugin's module stopped unexpectedly"),
        }
    }
}

fn compile(engine: &Engine, path: &Path) -> Result<Module, String> {
    let size = std::fs::metadata(path)
        .map_err(|_| format!("{} is missing", path.display()))?
        .len();
    if size > MAX_MODULE {
        return Err("the module is too large".into());
    }
    let bytes = std::fs::read(path).map_err(|e| format!("can't read the module: {e}"))?;
    Module::new(engine, &bytes).map_err(|e| format!("the module is not valid WebAssembly: {e}"))
}

/// At review: the module compiles, exports what OpenRemote calls, and
/// imports only what its powers allow.
pub fn check(path: &Path, powers: &[openremote_core::PluginPower]) -> Result<(), String> {
    let mut config = Config::default();
    config.consume_fuel(true);
    let module = compile(&Engine::new(&config), path)?;
    for import in module.imports() {
        let name = import.name();
        let allowed = import.module() == "openremote"
            && IMPORTS
                .iter()
                .any(|(n, power)| *n == name && power.is_none_or(|p| powers.contains(&p)));
        if !allowed {
            let needs = IMPORTS
                .iter()
                .find(|(n, _)| *n == name)
                .and_then(|(_, p)| *p);
            return Err(match (import.module(), needs) {
                ("openremote", Some(power)) => format!(
                    "the module imports openremote.{name}, which needs the {} power its manifest doesn't ask for",
                    serde_json::to_value(power)
                        .ok()
                        .and_then(|v| v.as_str().map(String::from))
                        .unwrap_or_default()
                ),
                (module, _) => format!(
                    "the module imports {module}.{name}, which OpenRemote doesn't offer (a WASM plugin gets only openremote.log, http and take)"
                ),
            });
        }
    }
    let mut exports: Vec<&str> = module.exports().map(|e| e.name()).collect();
    exports.sort();
    for wanted in ["memory", "or_alloc", "or_call"] {
        if !exports.contains(&wanted) {
            return Err(format!(
                "the module doesn't export {wanted}; a tool module exports memory, or_alloc and or_call"
            ));
        }
    }
    Ok(())
}

fn trap(message: impl Into<String>) -> wasmi::Error {
    wasmi::Error::new(message.into())
}

fn memory_of(caller: &Caller<'_, Host>) -> Result<wasmi::Memory, wasmi::Error> {
    caller
        .get_export("memory")
        .and_then(Extern::into_memory)
        .ok_or_else(|| trap("the module exports no memory"))
}

fn read_guest(caller: &Caller<'_, Host>, ptr: i32, len: i32) -> Result<Vec<u8>, wasmi::Error> {
    let len = usize::try_from(len).map_err(|_| trap("a negative length"))?;
    if len > MAX_IO {
        return Err(trap("too much at once"));
    }
    let mut buf = vec![0; len];
    memory_of(caller)?
        .read(caller, ptr as u32 as usize, &mut buf)
        .map_err(|_| trap("out of the module's memory"))?;
    Ok(buf)
}

fn run(
    engine: &Engine,
    module: &Module,
    plugin: &str,
    network: bool,
    input: &Value,
    runtime: tokio::runtime::Handle,
) -> Result<Value, String> {
    let host = Host {
        limits: StoreLimitsBuilder::new()
            .memory_size(MEMORY)
            .instances(1)
            .tables(4)
            .memories(1)
            .build(),
        plugin: plugin.to_string(),
        requests_left: MAX_REQUESTS,
        held: Vec::new(),
        http: openremote_cloud::https::Http::new(),
        runtime,
    };
    let mut store = Store::new(engine, host);
    store.limiter(|host| &mut host.limits);
    store
        .set_fuel(FUEL)
        .map_err(|e| format!("fuel could not be set: {e}"))?;
    let mut linker = <Linker<Host>>::new(engine);
    linker
        .func_wrap(
            "openremote",
            "log",
            |caller: Caller<'_, Host>, ptr: i32, len: i32| -> Result<(), wasmi::Error> {
                let bytes = read_guest(&caller, ptr, len.min(4096))?;
                eprintln!(
                    "plugin {}: {}",
                    caller.data().plugin,
                    String::from_utf8_lossy(&bytes)
                );
                Ok(())
            },
        )
        .map_err(|e| e.to_string())?;
    if network {
        linker
            .func_wrap(
                "openremote",
                "http",
                |mut caller: Caller<'_, Host>, ptr: i32, len: i32| -> Result<i32, wasmi::Error> {
                    let request = read_guest(&caller, ptr, len)?;
                    let answer = http(caller.data_mut(), &request);
                    let bytes = serde_json::to_vec(&answer).expect("an answer serializes");
                    let size = bytes.len() as i32;
                    caller.data_mut().held = bytes;
                    Ok(size)
                },
            )
            .map_err(|e| e.to_string())?;
        linker
            .func_wrap(
                "openremote",
                "take",
                |mut caller: Caller<'_, Host>, ptr: i32, len: i32| -> Result<i32, wasmi::Error> {
                    let held = std::mem::take(&mut caller.data_mut().held);
                    let n = held.len().min(usize::try_from(len).unwrap_or(0));
                    memory_of(&caller)?
                        .write(&mut caller, ptr as u32 as usize, &held[..n])
                        .map_err(|_| trap("out of the module's memory"))?;
                    Ok(n as i32)
                },
            )
            .map_err(|e| e.to_string())?;
    }
    let instance = linker
        .instantiate(&mut store, module)
        .and_then(|pre| pre.start(&mut store))
        .map_err(|e| format!("the module could not start: {e}"))?;
    let memory = instance
        .get_memory(&store, "memory")
        .ok_or("the module exports no memory")?;
    let alloc = instance
        .get_typed_func::<i32, i32>(&store, "or_alloc")
        .map_err(|_| "the module's or_alloc is missing or not (i32) -> i32")?;
    let call = instance
        .get_typed_func::<(i32, i32), i64>(&store, "or_call")
        .map_err(|_| "the module's or_call is missing or not (i32, i32) -> i64")?;
    let bytes = serde_json::to_vec(input).expect("a call serializes");
    let ptr = alloc
        .call(&mut store, bytes.len() as i32)
        .map_err(|e| ran_out(&e))?;
    memory
        .write(&mut store, ptr as u32 as usize, &bytes)
        .map_err(|_| "or_alloc gave memory the module doesn't have")?;
    let packed = call
        .call(&mut store, (ptr, bytes.len() as i32))
        .map_err(|e| ran_out(&e))?;
    let (out_ptr, out_len) = (
        (packed as u64 >> 32) as usize,
        (packed as u64 & 0xffff_ffff) as usize,
    );
    if out_len > MAX_IO {
        return Err("the tool answered too much".into());
    }
    let mut out = vec![0; out_len];
    memory
        .read(&store, out_ptr, &mut out)
        .map_err(|_| "the tool's answer is outside its memory")?;
    let answer: Value =
        serde_json::from_slice(&out).map_err(|_| "the tool's answer is not JSON".to_string())?;
    Ok(super::tool_result(answer))
}

/// Why a call stopped, in plain words: the limits get their own.
fn ran_out(e: &wasmi::Error) -> String {
    let text = e.to_string();
    if text.contains("fuel") {
        "the tool ran past its time limit and was stopped".into()
    } else if text.contains("memory") && text.contains("limit") {
        "the tool ran past its memory limit and was stopped".into()
    } else {
        format!("the tool stopped with an error: {text}")
    }
}

/// One request through the daemon's own HTTP client, for a module with
/// the network power: the internet only - never this machine or its
/// network's private addresses.
fn http(host: &mut Host, raw: &[u8]) -> Value {
    if host.requests_left == 0 {
        return json!({"error": format!("a call may make {MAX_REQUESTS} requests at most")});
    }
    host.requests_left -= 1;
    let Ok(request) = serde_json::from_slice::<Value>(raw) else {
        return json!({"error": "the request is not JSON"});
    };
    let method = request["method"].as_str().unwrap_or("GET").to_uppercase();
    let Some(url) = request["url"].as_str().map(String::from) else {
        return json!({"error": "the request names no url"});
    };
    if let Err(why) = host.runtime.block_on(public_address(&url)) {
        return json!({"error": why});
    }
    let headers: Vec<(String, String)> = request["headers"]
        .as_object()
        .map(|h| {
            h.iter()
                .filter_map(|(k, v)| Some((k.clone(), v.as_str()?.to_string())))
                .collect()
        })
        .unwrap_or_default();
    let body = request["body"].as_str().map(|text| {
        let kind = request["content_type"]
            .as_str()
            .unwrap_or("text/plain; charset=utf-8")
            .to_string();
        (kind, text.as_bytes().to_vec())
    });
    let http = host.http.clone();
    let answer = host.runtime.block_on(async move {
        let header_refs: Vec<(&str, &str)> = headers
            .iter()
            .map(|(k, v)| (k.as_str(), v.as_str()))
            .collect();
        http.request_within(
            REQUEST_TIME,
            &method,
            &url,
            &header_refs,
            body.as_ref().map(|(k, b)| (k.as_str(), b.clone())),
        )
        .await
    });
    match answer {
        Ok(response) => {
            let headers: serde_json::Map<String, Value> = response
                .headers
                .iter()
                .filter_map(|(k, v)| Some((k.to_string(), Value::String(v.to_str().ok()?.into()))))
                .collect();
            match String::from_utf8(response.body) {
                Ok(text) => json!({"status": response.status, "headers": headers, "body": text}),
                Err(raw) => {
                    use base64::Engine as _;
                    json!({
                        "status": response.status,
                        "headers": headers,
                        "body_base64": base64::engine::general_purpose::STANDARD.encode(raw.into_bytes()),
                    })
                }
            }
        }
        Err(e) => json!({"error": e.to_string()}),
    }
}

/// An http(s) address that leads to the public internet. A name is looked
/// up first: one that answers with a loopback, private or link-local
/// address (this machine, the home network, a cloud's metadata service)
/// is refused.
async fn public_address(url: &str) -> Result<(), String> {
    let uri: axum::http::Uri = url
        .parse()
        .map_err(|_| format!("'{url}' is not an address"))?;
    if !matches!(uri.scheme_str(), Some("http" | "https")) {
        return Err("a request goes to an http or https address".into());
    }
    let host = uri
        .host()
        .ok_or("the address names no host")?
        .trim_start_matches('[')
        .trim_end_matches(']')
        .to_string();
    if host.eq_ignore_ascii_case("localhost") || host.to_ascii_lowercase().ends_with(".localhost") {
        return Err("a plugin reaches the internet, not this machine".into());
    }
    let port = uri.port_u16().unwrap_or(80);
    let addresses: Vec<IpAddr> = match host.parse::<IpAddr>() {
        Ok(ip) => vec![ip],
        Err(_) => tokio::net::lookup_host((host.as_str(), port))
            .await
            .map_err(|_| format!("{host} could not be found"))?
            .map(|a| a.ip())
            .collect(),
    };
    if addresses.iter().any(|ip| !is_public(ip)) {
        return Err("a plugin reaches the internet, not this machine or its network".into());
    }
    Ok(())
}

fn is_public(ip: &IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            !(v4.is_loopback()
                || v4.is_private()
                || v4.is_link_local()
                || v4.is_unspecified()
                || v4.is_broadcast()
                // 100.64.0.0/10, the carrier-grade NAT range.
                || (v4.octets()[0] == 100 && (v4.octets()[1] & 0xc0) == 64))
        }
        IpAddr::V6(v6) => {
            let first = v6.segments()[0];
            !(v6.is_loopback()
                || v6.is_unspecified()
                // fc00::/7 unique local, fe80::/10 link-local
                || (first & 0xfe00) == 0xfc00
                || (first & 0xffc0) == 0xfe80
                || v6.to_ipv4_mapped().is_some_and(|v4| !is_public(&IpAddr::V4(v4))))
        }
    }
}

fn error_result(text: &str) -> Value {
    json!({"content": [{"type": "text", "text": text}], "isError": true})
}
