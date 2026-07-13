fn main() {
    println!("cargo:rerun-if-env-changed=DAYTRADINGBOT_OWNER_DEMO_CODE_SHA256");
    if std::env::var_os("CARGO_FEATURE_OWNER_DEMO_LICENSE").is_some() {
        let hash = std::env::var("DAYTRADINGBOT_OWNER_DEMO_CODE_SHA256")
            .expect("owner-demo-license builds require DAYTRADINGBOT_OWNER_DEMO_CODE_SHA256");
        assert!(
            hash.len() == 64 && hash.bytes().all(|byte| byte.is_ascii_hexdigit()),
            "DAYTRADINGBOT_OWNER_DEMO_CODE_SHA256 must be a 64-character SHA-256 hex digest"
        );
    }
    tauri_build::build();
}
