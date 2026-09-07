#[path = "src/catalog_projection.rs"]
mod catalog_projection;

fn main() {
    println!("cargo:rerun-if-changed=../public/catalog.json");
    println!("cargo:rerun-if-changed=src/catalog_projection.rs");
    let bytes = std::fs::read("../public/catalog.json").expect("Read bundled catalog");
    let value = serde_json::from_slice(&bytes).expect("Decode bundled catalog");
    let pricing = catalog_projection::pricing(&value).expect("Validate bundled prices");
    let output =
        std::path::PathBuf::from(std::env::var_os("OUT_DIR").expect("Cargo output directory"));
    std::fs::write(
        output.join("pricing.json"),
        serde_json::to_vec(&pricing).unwrap(),
    )
    .expect("Write compact pricing");
    tauri_build::build()
}
