//! Transitional adapter for the founder's proven Desk OS installation.
//!
//! The commercial runtime will bundle the same strategy source behind its own
//! scheduler. Until that packaging step is complete, this adapter lets the
//! founder desktop control the already-installed engine without restarting the
//! legacy localhost control server. All paths and actions are fixed; the
//! webview cannot supply a command, path, URL, or launchd label.

use crate::agent_catalog::{TradingAgent, load_agent_catalog};
use crate::bluechip_runtime::{
    BluechipConfig, BluechipRuntime, NativeTradingMode, decimal_from_customer_amount,
    license_entries_allowed,
};
use crate::vault::{CredentialVault, VaultKey};
use daytradingbot_ledger::Ledger;
use daytradingbot_licensing::LicenseGate;
use plist::{Dictionary, Value};
use serde::{Deserialize, Serialize};
use serde_json::{Map, json};
use std::collections::{HashMap, HashSet};
use std::fs::Permissions;
use std::path::PathBuf;
use std::process::Command;
use std::time::Duration;
use tauri::AppHandle;
use zeroize::Zeroizing;

#[derive(Clone)]
struct OwnerRuntimePaths {
    launch_control: PathBuf,
    launch_agents: PathBuf,
}

impl OwnerRuntimePaths {
    fn discover() -> Option<Self> {
        #[cfg(not(debug_assertions))]
        {
            return None;
        }

        #[cfg(debug_assertions)]
        {
            let home = PathBuf::from(std::env::var_os("HOME")?);
            let workspace = home.join(".openclaw/workspace-dev");
            let launch_control = workspace.join("runtime/launch_control.json");
            let launch_agents = home.join("Library/LaunchAgents");
            if !launch_control.is_file() || !launch_agents.is_dir() {
                return None;
            }
            Some(Self {
                launch_control,
                launch_agents,
            })
        }
    }

    fn plist(&self, label: &str) -> PathBuf {
        self.launch_agents.join(format!("{label}.plist"))
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
enum TradingMode {
    Practice,
    Real,
}

#[derive(Debug, Deserialize)]
pub struct StartSessionRequest {
    agent_ids: Vec<String>,
    mode: TradingMode,
    daily_budget_usd: f64,
    max_per_trade_usd: f64,
    real_confirmation: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct OwnerEngineStatus {
    available: bool,
    mode: &'static str,
    selected_agent_ids: Vec<String>,
    loaded_agent_ids: Vec<String>,
    message: String,
}

#[derive(Debug, Serialize)]
pub struct SessionActionResult {
    mode: &'static str,
    selected_agent_ids: Vec<String>,
    message: String,
}

#[derive(Clone, Debug)]
struct ValidatedSession {
    agents: Vec<TradingAgent>,
    mode: TradingMode,
    daily_budget_usd: f64,
    max_per_trade_usd: f64,
}

fn validate_request(request: StartSessionRequest) -> Result<ValidatedSession, &'static str> {
    if request.agent_ids.is_empty() || request.agent_ids.len() > 3 {
        return Err("CHOOSE_ONE_TO_THREE_AGENTS");
    }
    if !request.daily_budget_usd.is_finite()
        || request.daily_budget_usd < 1.0
        || request.daily_budget_usd > 25.0
    {
        return Err("DAILY_BUDGET_MUST_BE_BETWEEN_1_AND_25");
    }
    if !request.max_per_trade_usd.is_finite()
        || request.max_per_trade_usd < 1.0
        || request.max_per_trade_usd > 5.0
        || request.max_per_trade_usd > request.daily_budget_usd
    {
        return Err("TRADE_LIMIT_MUST_BE_BETWEEN_1_AND_5");
    }
    if matches!(request.mode, TradingMode::Real)
        && request.real_confirmation.as_deref() != Some("START REAL TRADING")
    {
        return Err("REAL_TRADING_CONFIRMATION_REQUIRED");
    }

    let catalog = load_agent_catalog()?;
    let by_id: HashMap<_, _> = catalog
        .agents
        .into_iter()
        .map(|agent| (agent.id.clone(), agent))
        .collect();
    let mut unique = HashSet::new();
    let mut agents = Vec::with_capacity(request.agent_ids.len());
    for id in request.agent_ids {
        if !unique.insert(id.clone()) {
            return Err("AGENT_SELECTION_HAS_DUPLICATES");
        }
        let agent = by_id.get(&id).cloned().ok_or("UNKNOWN_TRADING_AGENT")?;
        if !cfg!(debug_assertions) && !agent.customer_ready {
            return Err("AGENT_NOT_AVAILABLE_IN_THIS_BUILD");
        }
        if matches!(request.mode, TradingMode::Practice) && !agent.practice_available {
            return Err("AGENT_DOES_NOT_SUPPORT_PRACTICE");
        }
        if matches!(request.mode, TradingMode::Real) && !agent.real_trading_available {
            return Err("AGENT_DOES_NOT_SUPPORT_REAL_TRADING");
        }
        agents.push(agent);
    }
    if agents.iter().any(|agent| agent.id == "bluechip") && agents.len() != 1 {
        return Err("BLUECHIP_RUNS_BY_ITSELF_FOR_NOW");
    }
    if matches!(request.mode, TradingMode::Real) && agents.len() != 1 {
        return Err("REAL_TRADING_ONE_AGENT_AT_A_TIME");
    }

    Ok(ValidatedSession {
        agents,
        mode: request.mode,
        daily_budget_usd: request.daily_budget_usd,
        max_per_trade_usd: request.max_per_trade_usd,
    })
}

fn read_control(paths: &OwnerRuntimePaths) -> Map<String, serde_json::Value> {
    std::fs::read_to_string(&paths.launch_control)
        .ok()
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_default()
}

fn write_control(
    paths: &OwnerRuntimePaths,
    updates: impl IntoIterator<Item = (&'static str, serde_json::Value)>,
) -> Result<(), &'static str> {
    let mut control = read_control(paths);
    for (key, value) in updates {
        control.insert(key.to_string(), value);
    }
    let body = serde_json::to_vec_pretty(&control).map_err(|_| "ENGINE_CONTROL_WRITE_FAILED")?;
    let temp = paths.launch_control.with_extension("json.tmp");
    std::fs::write(&temp, body).map_err(|_| "ENGINE_CONTROL_WRITE_FAILED")?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&temp, Permissions::from_mode(0o600))
            .map_err(|_| "ENGINE_CONTROL_WRITE_FAILED")?;
    }
    std::fs::rename(temp, &paths.launch_control).map_err(|_| "ENGINE_CONTROL_WRITE_FAILED")
}

fn stand_down(paths: &OwnerRuntimePaths) -> Result<(), &'static str> {
    write_control(
        paths,
        [
            ("global_kill_switch", json!(true)),
            ("allow_live_trading", json!(false)),
            ("allow_sim_live", json!(false)),
            ("launch_posture", json!("paused_from_desktop")),
            ("selected_agent_ids", json!([])),
        ],
    )
}

fn user_id() -> Result<String, &'static str> {
    let output = Command::new("/usr/bin/id")
        .arg("-u")
        .output()
        .map_err(|_| "ENGINE_CONTROL_UNAVAILABLE")?;
    if !output.status.success() {
        return Err("ENGINE_CONTROL_UNAVAILABLE");
    }
    String::from_utf8(output.stdout)
        .map(|uid| uid.trim().to_string())
        .map_err(|_| "ENGINE_CONTROL_UNAVAILABLE")
}

fn launchctl(args: &[String]) -> Result<String, &'static str> {
    let output = Command::new("/bin/launchctl")
        .args(args)
        .output()
        .map_err(|_| "ENGINE_CONTROL_UNAVAILABLE")?;
    let text = format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    if output.status.success() {
        Ok(text)
    } else {
        Err("ENGINE_ACTION_FAILED")
    }
}

fn unload_agent(uid: &str, label: &str) {
    let _ = launchctl(&["bootout".into(), format!("gui/{uid}/{label}")]);
}

fn load_agent(paths: &OwnerRuntimePaths, uid: &str, label: &str) -> Result<(), &'static str> {
    let plist = paths.plist(label);
    if !plist.is_file() {
        return Err("AGENT_INSTALLATION_INCOMPLETE");
    }
    let _ = launchctl(&["enable".into(), format!("gui/{uid}/{label}")]);
    launchctl(&[
        "bootstrap".into(),
        format!("gui/{uid}"),
        plist.to_string_lossy().into_owned(),
    ])?;
    Ok(())
}

fn kickstart_agent(uid: &str, label: &str) -> Result<(), &'static str> {
    launchctl(&["kickstart".into(), format!("gui/{uid}/{label}")])?;
    Ok(())
}

fn environment_dictionary(dictionary: &mut Dictionary) -> Result<&mut Dictionary, &'static str> {
    if !dictionary.contains_key("EnvironmentVariables") {
        dictionary.insert(
            "EnvironmentVariables".into(),
            Value::Dictionary(Dictionary::new()),
        );
    }
    dictionary
        .get_mut("EnvironmentVariables")
        .and_then(Value::as_dictionary_mut)
        .ok_or("AGENT_INSTALLATION_INVALID")
}

fn set_env(environment: &mut Dictionary, key: &str, value: impl ToString) {
    environment.insert(key.into(), Value::String(value.to_string()));
}

fn apply_agent_limits(
    environment: &mut Dictionary,
    agent: &TradingAgent,
    session: &ValidatedSession,
) {
    let trade = format!("{:.2}", session.max_per_trade_usd);
    let daily = format!("{:.2}", session.daily_budget_usd);
    set_env(environment, "DAYTRADINGBOT_MAX_PER_TRADE_USD", &trade);
    set_env(environment, "DAYTRADINGBOT_DAILY_BUDGET_USD", &daily);
    match agent.id.as_str() {
        "sprinter" => {
            set_env(environment, "SIMMER_FASTLOOP_MAX_POSITION_USD", &trade);
            set_env(environment, "SIMMER_FASTLOOP_DAILY_BUDGET_USD", &daily);
        }
        "oracle-gap-polymarket" | "oracle-gap-kalshi" => {
            set_env(environment, "SIMMER_DIVERGENCE_MAX_BET_USD", &trade);
            set_env(environment, "SIMMER_DIVERGENCE_DAILY_BUDGET_USD", &daily);
        }
        "stormfront" | "barometer" => {
            set_env(environment, "SIMMER_WEATHER_MAX_POSITION_USD", &trade);
        }
        "smart-money" => set_env(environment, "SIMMER_COPYTRADING_MAX_USD", &trade),
        "news-watch" => set_env(environment, "SIMMER_SNIPER_MAX_USD", &trade),
        "last-call" => set_env(environment, "SIMMER_MERT_MAX_BET", &trade),
        "x-pulse" => set_env(environment, "SIMMER_ELON_MAX_POSITION", &trade),
        _ => {}
    }
}

fn configure_agent_plist(
    paths: &OwnerRuntimePaths,
    agent: &TradingAgent,
    session: &ValidatedSession,
) -> Result<(), &'static str> {
    let path = paths.plist(&agent.engine.legacy_label);
    let metadata = std::fs::metadata(&path).map_err(|_| "AGENT_INSTALLATION_INCOMPLETE")?;
    let mut plist = Value::from_file(&path).map_err(|_| "AGENT_INSTALLATION_INVALID")?;
    let dictionary = plist
        .as_dictionary_mut()
        .ok_or("AGENT_INSTALLATION_INVALID")?;

    let arguments = dictionary
        .get_mut("ProgramArguments")
        .and_then(Value::as_array_mut)
        .ok_or("AGENT_INSTALLATION_INVALID")?;
    arguments.retain(|value| value.as_string() != Some("--live"));
    if agent.engine.kind == "simmer" || matches!(session.mode, TradingMode::Real) {
        arguments.push(Value::String("--live".into()));
    }

    let environment = environment_dictionary(dictionary)?;
    if agent.engine.kind == "simmer" {
        let venue = match session.mode {
            TradingMode::Practice => "sim",
            TradingMode::Real if agent.account == "Kalshi" => "kalshi",
            TradingMode::Real => "polymarket",
        };
        set_env(environment, "TRADING_VENUE", venue);
    } else {
        environment.remove("TRADING_VENUE");
    }
    apply_agent_limits(environment, agent, session);

    let temp = path.with_extension("plist.tmp");
    plist
        .to_file_xml(&temp)
        .map_err(|_| "AGENT_CONFIGURATION_WRITE_FAILED")?;
    std::fs::set_permissions(&temp, metadata.permissions())
        .map_err(|_| "AGENT_CONFIGURATION_WRITE_FAILED")?;
    std::fs::rename(temp, path).map_err(|_| "AGENT_CONFIGURATION_WRITE_FAILED")
}

fn loaded_labels() -> HashSet<String> {
    let output = Command::new("/bin/launchctl").arg("list").output();
    let Ok(output) = output else {
        return HashSet::new();
    };
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| line.split('\t').nth(2))
        .map(str::to_string)
        .collect()
}

async fn update_simmer_settings(
    vault: &CredentialVault,
    daily_budget_usd: f64,
    max_per_trade_usd: f64,
    paused: bool,
) -> Result<(), &'static str> {
    let Some(raw_key) = vault
        .load_optional(VaultKey::SimmerApiKey)
        .map_err(|_| "ACCOUNT_VAULT_UNAVAILABLE")?
    else {
        return Err("SIMMER_ACCOUNT_NOT_CONNECTED");
    };
    let api_key = Zeroizing::new(
        String::from_utf8(raw_key.to_vec()).map_err(|_| "SIMMER_ACCOUNT_CONNECTION_INVALID")?,
    );
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(12))
        .user_agent("DayTradingBot/0.1 owner-engine-bridge")
        .build()
        .map_err(|_| "SIMMER_SETTINGS_UNAVAILABLE")?;

    let requests = [
        (
            "https://api.simmer.markets/api/sdk/settings",
            json!({
                "sdk_max_trade_amount": max_per_trade_usd,
                "sdk_daily_limit": daily_budget_usd,
                "trading_paused": paused
            }),
        ),
        (
            "https://api.simmer.markets/api/sdk/user/settings",
            json!({
                "max_position_usd": max_per_trade_usd,
                "sdk_daily_limit": daily_budget_usd,
                "trading_paused": paused
            }),
        ),
    ];
    for (url, body) in requests {
        let response = client
            .patch(url)
            .bearer_auth(api_key.as_str())
            .json(&body)
            .send()
            .await
            .map_err(|_| "SIMMER_SETTINGS_UNAVAILABLE")?;
        if !response.status().is_success() {
            return Err("SIMMER_SETTINGS_REJECTED");
        }
    }
    Ok(())
}

async fn set_simmer_paused(vault: &CredentialVault, paused: bool) -> Result<(), &'static str> {
    let Some(raw_key) = vault
        .load_optional(VaultKey::SimmerApiKey)
        .map_err(|_| "ACCOUNT_VAULT_UNAVAILABLE")?
    else {
        return Ok(());
    };
    let api_key = Zeroizing::new(
        String::from_utf8(raw_key.to_vec()).map_err(|_| "SIMMER_ACCOUNT_CONNECTION_INVALID")?,
    );
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(12))
        .user_agent("DayTradingBot/0.1 owner-engine-bridge")
        .build()
        .map_err(|_| "SIMMER_SETTINGS_UNAVAILABLE")?;
    for url in [
        "https://api.simmer.markets/api/sdk/settings",
        "https://api.simmer.markets/api/sdk/user/settings",
    ] {
        let response = client
            .patch(url)
            .bearer_auth(api_key.as_str())
            .json(&json!({ "trading_paused": paused }))
            .send()
            .await
            .map_err(|_| "SIMMER_SETTINGS_UNAVAILABLE")?;
        if !response.status().is_success() {
            return Err("SIMMER_SETTINGS_REJECTED");
        }
    }
    Ok(())
}

#[tauri::command]
pub fn owner_engine_status(runtime: tauri::State<'_, BluechipRuntime>) -> OwnerEngineStatus {
    let native = runtime.status();
    if native.running {
        return OwnerEngineStatus {
            available: true,
            mode: native.mode,
            selected_agent_ids: vec!["bluechip".into()],
            loaded_agent_ids: vec!["bluechip".into()],
            message: native.message,
        };
    }
    let Some(paths) = OwnerRuntimePaths::discover() else {
        return OwnerEngineStatus {
            available: true,
            mode: "paused",
            selected_agent_ids: Vec::new(),
            loaded_agent_ids: Vec::new(),
            message: "Trading is paused.".into(),
        };
    };
    let catalog = match load_agent_catalog() {
        Ok(catalog) => catalog,
        Err(_) => {
            return OwnerEngineStatus {
                available: false,
                mode: "unavailable",
                selected_agent_ids: Vec::new(),
                loaded_agent_ids: Vec::new(),
                message: "The trading-agent list could not be loaded.".into(),
            };
        }
    };
    let control = read_control(&paths);
    let global_stop = control
        .get("global_kill_switch")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(true);
    let real = control
        .get("allow_live_trading")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false);
    let practice = control
        .get("allow_sim_live")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false);
    let mode = if !global_stop && real {
        "real"
    } else if practice {
        "practice"
    } else {
        "paused"
    };
    let selected_agent_ids = control
        .get("selected_agent_ids")
        .and_then(serde_json::Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(serde_json::Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    let loaded = loaded_labels();
    let loaded_agent_ids = catalog
        .agents
        .iter()
        .filter(|agent| loaded.contains(&agent.engine.legacy_label))
        .map(|agent| agent.id.clone())
        .collect();
    OwnerEngineStatus {
        available: true,
        mode,
        selected_agent_ids,
        loaded_agent_ids,
        message: match mode {
            "real" => "Real trading is running.".into(),
            "practice" => "Practice trading is running.".into(),
            _ => "Trading is paused.".into(),
        },
    }
}

#[tauri::command]
pub async fn start_owner_engine_session(
    request: StartSessionRequest,
    app: AppHandle,
    vault: tauri::State<'_, CredentialVault>,
    gate: tauri::State<'_, LicenseGate>,
    ledger: tauri::State<'_, Ledger>,
    native_runtime: tauri::State<'_, BluechipRuntime>,
) -> Result<SessionActionResult, &'static str> {
    let session = validate_request(request)?;
    let catalog = load_agent_catalog()?;

    if session.agents[0].id == "bluechip" {
        if let Some(paths) = OwnerRuntimePaths::discover() {
            let uid = user_id()?;
            stand_down(&paths)?;
            for agent in &catalog.agents {
                unload_agent(&uid, &agent.engine.legacy_label);
            }
        }
        let mode = match session.mode {
            TradingMode::Practice => NativeTradingMode::Practice,
            TradingMode::Real => NativeTradingMode::Real,
        };
        let status = native_runtime
            .start(
                app,
                BluechipConfig {
                    mode,
                    daily_budget_usd: decimal_from_customer_amount(session.daily_budget_usd)?,
                    max_per_trade_usd: decimal_from_customer_amount(session.max_per_trade_usd)?,
                },
            )
            .await?;
        return Ok(SessionActionResult {
            mode: status.mode,
            selected_agent_ids: vec!["bluechip".into()],
            message: status.message,
        });
    }

    let _ = native_runtime.pause(&ledger)?;
    if matches!(session.mode, TradingMode::Real) && !license_entries_allowed(&gate, &vault)? {
        return Err("REAL_TRADING_LICENSE_REQUIRED");
    }
    let paths = OwnerRuntimePaths::discover().ok_or("TRADING_AGENT_INSTALLATION_INCOMPLETE")?;
    let uid = user_id()?;

    stand_down(&paths)?;
    for agent in &catalog.agents {
        unload_agent(&uid, &agent.engine.legacy_label);
    }

    let uses_simmer = session
        .agents
        .iter()
        .any(|agent| agent.engine.kind == "simmer");
    if uses_simmer
        && let Err(error) = update_simmer_settings(
            &vault,
            session.daily_budget_usd,
            session.max_per_trade_usd,
            false,
        )
        .await
    {
        let _ = stand_down(&paths);
        return Err(error);
    }

    for agent in &session.agents {
        if let Err(error) = configure_agent_plist(&paths, agent, &session)
            .and_then(|()| load_agent(&paths, &uid, &agent.engine.legacy_label))
        {
            let _ = stand_down(&paths);
            for known in &catalog.agents {
                unload_agent(&uid, &known.engine.legacy_label);
            }
            if uses_simmer {
                let _ = update_simmer_settings(
                    &vault,
                    session.daily_budget_usd,
                    session.max_per_trade_usd,
                    true,
                )
                .await;
            }
            return Err(error);
        }
    }

    let ids: Vec<_> = session
        .agents
        .iter()
        .map(|agent| agent.id.clone())
        .collect();
    let mode_name = match session.mode {
        TradingMode::Practice => "practice",
        TradingMode::Real => "real",
    };
    let control_result = match session.mode {
        TradingMode::Practice => write_control(
            &paths,
            [
                ("global_kill_switch", json!(true)),
                ("allow_live_trading", json!(false)),
                ("allow_sim_live", json!(true)),
                ("launch_posture", json!("practice_from_desktop")),
                ("selected_agent_ids", json!(ids)),
                ("daily_budget_usd", json!(session.daily_budget_usd)),
                ("max_per_trade_usd", json!(session.max_per_trade_usd)),
            ],
        ),
        TradingMode::Real => write_control(
            &paths,
            [
                ("global_kill_switch", json!(false)),
                ("allow_live_trading", json!(true)),
                ("allow_sim_live", json!(true)),
                ("launch_posture", json!("real_from_desktop")),
                ("selected_agent_ids", json!(ids)),
                ("daily_budget_usd", json!(session.daily_budget_usd)),
                ("max_per_trade_usd", json!(session.max_per_trade_usd)),
            ],
        ),
    };
    if let Err(error) = control_result {
        let _ = stand_down(&paths);
        return Err(error);
    }

    for agent in &session.agents {
        if let Err(error) = kickstart_agent(&uid, &agent.engine.legacy_label) {
            let _ = stand_down(&paths);
            for known in &catalog.agents {
                unload_agent(&uid, &known.engine.legacy_label);
            }
            return Err(error);
        }
    }

    Ok(SessionActionResult {
        mode: mode_name,
        selected_agent_ids: ids,
        message: if matches!(session.mode, TradingMode::Practice) {
            "Practice trading started. No real money will be used.".into()
        } else {
            "Real trading started with the selected agents and limits.".into()
        },
    })
}

#[tauri::command]
pub async fn pause_owner_engine_session(
    vault: tauri::State<'_, CredentialVault>,
    ledger: tauri::State<'_, Ledger>,
    native_runtime: tauri::State<'_, BluechipRuntime>,
) -> Result<SessionActionResult, &'static str> {
    let native_was_running = native_runtime.status().running;
    let _ = native_runtime.pause(&ledger)?;
    if let Some(paths) = OwnerRuntimePaths::discover() {
        stand_down(&paths)?;
        let uid = user_id()?;
        let catalog = load_agent_catalog()?;
        for agent in &catalog.agents {
            unload_agent(&uid, &agent.engine.legacy_label);
        }
    }
    // Bluechip is entirely native and never needs the legacy Simmer account bridge.
    // Avoid reading an unrelated keychain item or waiting on a remote API when the
    // customer pauses the bundled agent.
    if !native_was_running {
        let _ = set_simmer_paused(&vault, true).await;
    }
    Ok(SessionActionResult {
        mode: "paused",
        selected_agent_ids: Vec::new(),
        message: "Trading is paused. No new trades will start.".into(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(mode: TradingMode) -> StartSessionRequest {
        StartSessionRequest {
            agent_ids: vec!["sprinter".into()],
            mode,
            daily_budget_usd: 20.0,
            max_per_trade_usd: 5.0,
            real_confirmation: Some("START REAL TRADING".into()),
        }
    }

    #[test]
    fn request_limits_are_bounded() {
        assert!(validate_request(request(TradingMode::Practice)).is_ok());
        let mut too_large = request(TradingMode::Practice);
        too_large.daily_budget_usd = 25.01;
        assert!(validate_request(too_large).is_err());
        let mut trade_too_large = request(TradingMode::Practice);
        trade_too_large.max_per_trade_usd = 5.01;
        assert!(validate_request(trade_too_large).is_err());
    }

    #[test]
    fn real_mode_requires_the_exact_confirmation() {
        let mut unconfirmed = request(TradingMode::Real);
        unconfirmed.real_confirmation = None;
        assert_eq!(
            validate_request(unconfirmed).expect_err("confirmation is required"),
            "REAL_TRADING_CONFIRMATION_REQUIRED"
        );
    }

    #[test]
    fn bluechip_uses_the_native_limited_path_by_itself() {
        let mut bluechip = request(TradingMode::Real);
        bluechip.agent_ids = vec!["bluechip".into()];
        assert!(validate_request(bluechip).is_ok());

        let mut mixed = request(TradingMode::Practice);
        mixed.agent_ids = vec!["bluechip".into(), "sprinter".into()];
        assert_eq!(
            validate_request(mixed).expect_err("native and transitional runtimes must not mix"),
            "BLUECHIP_RUNS_BY_ITSELF_FOR_NOW"
        );
    }
}
