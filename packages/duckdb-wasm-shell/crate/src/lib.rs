pub mod duckdb;
pub mod shell;
pub mod shell_embedding;
pub mod shell_options;
pub mod term_codes;
pub mod term_printing;
pub mod xterm;

use wasm_bindgen::prelude::*;

#[wasm_bindgen(start)]
pub fn main() {
    console_error_panic_hook::set_once();
}