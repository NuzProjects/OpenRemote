//! text-tools: an example OpenRemote WASM plugin. Three agent tools -
//! `slugify`, `stats` and `page_title` - compiled to a WebAssembly module
//! that OpenRemote runs inside its daemon, sandboxed: the module sees its
//! own memory and the host functions its powers grant (here, with the
//! network power, HTTP requests to the internet), nothing else.
//!
//! The contract (docs/plugins/protocol.md, "WASM plugins"): OpenRemote
//! writes each call's JSON into memory `or_alloc` hands it, calls
//! `or_call`, and reads the MCP tool result it points back at. Every call
//! runs on a fresh instance, so nothing here needs freeing: the whole
//! memory goes when the call ends.
//!
//! Build: `sh build.sh` (needs `rustup target add wasm32-unknown-unknown`).

use serde_json::{json, Value};

#[link(wasm_import_module = "openremote")]
extern "C" {
    /// A line on OpenRemote's stderr.
    fn log(ptr: *const u8, len: i32);
    /// One HTTP request (JSON in); answers the length of its JSON answer.
    fn http(ptr: *const u8, len: i32) -> i32;
    /// Copy the last answer into memory; answers how many bytes it copied.
    fn take(ptr: *mut u8, len: i32) -> i32;
}

/// Room for OpenRemote to write a call's input into.
#[no_mangle]
pub extern "C" fn or_alloc(len: i32) -> i32 {
    let mut room = Vec::<u8>::with_capacity(len.max(0) as usize);
    let ptr = room.as_mut_ptr();
    std::mem::forget(room);
    ptr as i32
}

/// One tool call: the input's JSON in, `(ptr << 32) | len` of the answer's
/// JSON out.
#[no_mangle]
pub extern "C" fn or_call(ptr: i32, len: i32) -> i64 {
    // SAFETY: OpenRemote wrote exactly `len` bytes at `ptr`, inside memory
    // `or_alloc` reserved for them.
    let input = unsafe { std::slice::from_raw_parts(ptr as *const u8, len.max(0) as usize) };
    let answer = match serde_json::from_slice::<Value>(input) {
        Ok(call) => run(&call),
        Err(e) => error(&format!("the call is not JSON: {e}")),
    };
    let out = serde_json::to_vec(&answer)
        .unwrap_or_default()
        .into_boxed_slice();
    let out_len = out.len() as i64;
    let out_ptr = Box::into_raw(out) as *mut u8 as usize as i64;
    (out_ptr << 32) | out_len
}

fn say(line: &str) {
    // SAFETY: the pointer and length name a live string's bytes.
    unsafe { log(line.as_ptr(), line.len() as i32) }
}

fn run(call: &Value) -> Value {
    let args = &call["arguments"];
    match call["tool"].as_str().unwrap_or_default() {
        "slugify" => slugify(args, &call["settings"]),
        "stats" => stats(args),
        "page_title" => page_title(args),
        other => error(&format!("text-tools has no tool named {other}")),
    }
}

fn text(content: String) -> Value {
    json!({"content": [{"type": "text", "text": content}]})
}

fn error(message: &str) -> Value {
    json!({"content": [{"type": "text", "text": message}], "isError": true})
}

fn slugify(args: &Value, settings: &Value) -> Value {
    let Some(title) = args["text"].as_str() else {
        return error("slugify needs the text to turn into a slug");
    };
    let separator = settings["separator"].as_str().unwrap_or("-");
    let words: Vec<String> = title
        .split(|c: char| !c.is_alphanumeric())
        .filter(|w| !w.is_empty())
        .map(str::to_lowercase)
        .collect();
    text(words.join(separator))
}

fn stats(args: &Value) -> Value {
    let Some(body) = args["text"].as_str() else {
        return error("stats needs the text to count");
    };
    let words = body.split_whitespace().count();
    let lines = if body.is_empty() { 0 } else { body.lines().count() };
    // A sentence ends at a run of . ! or ?
    let sentences = body
        .split(['.', '!', '?'])
        .filter(|s| !s.trim().is_empty())
        .count();
    let characters = body.chars().count();
    text(format!(
        "{words} words, {lines} lines, {sentences} sentences, {characters} characters"
    ))
}

/// One request through OpenRemote's own HTTP client.
fn fetch(request: &Value) -> Value {
    let raw = serde_json::to_vec(request).unwrap_or_default();
    // SAFETY: `raw` is alive across the call; `buf` has `size` bytes of room.
    let size = unsafe { http(raw.as_ptr(), raw.len() as i32) };
    let mut buf = vec![0u8; size.max(0) as usize];
    let got = unsafe { take(buf.as_mut_ptr(), size) };
    buf.truncate(got.max(0) as usize);
    serde_json::from_slice(&buf).unwrap_or(Value::Null)
}

fn page_title(args: &Value) -> Value {
    let Some(url) = args["url"].as_str() else {
        return error("page_title needs the page's url");
    };
    say(&format!("fetching {url}"));
    let answer = fetch(&json!({"method": "GET", "url": url, "headers": {"accept": "text/html"}}));
    if let Some(why) = answer["error"].as_str() {
        return error(&format!("could not fetch {url}: {why}"));
    }
    let status = answer["status"].as_u64().unwrap_or(0);
    if status != 200 {
        return error(&format!("{url} answered {status}"));
    }
    match title_of(answer["body"].as_str().unwrap_or_default()) {
        Some(title) => text(title),
        None => error(&format!("{url} has no title")),
    }
}

/// The text of a page's `<title>`, with the common entities read.
fn title_of(html: &str) -> Option<String> {
    let lower = html.to_ascii_lowercase();
    let open = lower.find("<title")?;
    let start = open + lower[open..].find('>')? + 1;
    let end = start + lower[start..].find("</title")?;
    let title = html[start..end]
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'");
    let title = title.split_whitespace().collect::<Vec<_>>().join(" ");
    (!title.is_empty()).then_some(title)
}
