#!/usr/bin/env sh
# Build text_tools.wasm, the module openremote.json names as its entry,
# then install the folder from Plugins > Install from a file or link.
# Needs Rust's WebAssembly target, once:
#   rustup target add wasm32-unknown-unknown
set -e
cd "$(dirname "$0")"
cargo build --release --target wasm32-unknown-unknown
cp target/wasm32-unknown-unknown/release/text_tools.wasm text_tools.wasm
echo "built text_tools.wasm"
