use serde::{Deserialize, Serialize};
use std::collections::HashSet;

const AGENT_MANIFEST: &str = include_str!("../../../../runtime/agents.json");

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct AgentCatalog {
    pub version: u32,
    pub agents: Vec<TradingAgent>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct TradingAgent {
    pub id: String,
    pub name: String,
    pub account: String,
    pub market: String,
    pub summary: String,
    pub cadence_minutes: u32,
    pub risk_level: String,
    pub practice_available: bool,
    pub real_trading_available: bool,
    pub customer_ready: bool,
    pub auto_pick_rank: u32,
    pub engine: AgentEngine,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct AgentEngine {
    pub kind: String,
    pub legacy_label: String,
    pub entrypoint: String,
}

pub fn load_agent_catalog() -> Result<AgentCatalog, &'static str> {
    let catalog: AgentCatalog =
        serde_json::from_str(AGENT_MANIFEST).map_err(|_| "AGENT_CATALOG_INVALID")?;
    validate_catalog(&catalog)?;
    Ok(catalog)
}

fn validate_catalog(catalog: &AgentCatalog) -> Result<(), &'static str> {
    if catalog.version == 0 || catalog.agents.is_empty() {
        return Err("AGENT_CATALOG_INVALID");
    }

    let mut ids = HashSet::new();
    let mut labels = HashSet::new();
    for agent in &catalog.agents {
        if agent.id.trim().is_empty()
            || agent.name.trim().is_empty()
            || agent.account.trim().is_empty()
            || agent.summary.trim().is_empty()
            || agent.cadence_minutes == 0
            || !matches!(agent.risk_level.as_str(), "steady" | "balanced" | "active")
            || !ids.insert(agent.id.as_str())
            || !labels.insert(agent.engine.legacy_label.as_str())
            || !agent.engine.entrypoint.starts_with("skills/")
            || agent.engine.entrypoint.contains("..")
        {
            return Err("AGENT_CATALOG_INVALID");
        }
    }
    Ok(())
}

#[tauri::command]
pub fn trading_agent_catalog() -> Result<AgentCatalog, &'static str> {
    let mut catalog = load_agent_catalog()?;
    if cfg!(debug_assertions) {
        for agent in &mut catalog.agents {
            agent.customer_ready = true;
        }
    }
    Ok(catalog)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bundled_catalog_is_valid_and_complete() {
        let catalog = load_agent_catalog().expect("bundled catalog should validate");
        assert_eq!(catalog.version, 1);
        assert!(catalog.agents.iter().any(|agent| agent.id == "bluechip"));
        assert!(catalog.agents.iter().any(|agent| agent.id == "sprinter"));
        assert!(catalog.agents.iter().any(|agent| agent.id == "barometer"));
        assert_eq!(
            catalog
                .agents
                .iter()
                .filter(|agent| agent.customer_ready)
                .map(|agent| agent.id.as_str())
                .collect::<Vec<_>>(),
            vec!["bluechip"]
        );
    }

    #[test]
    fn auto_pick_has_a_stable_first_choice() {
        let catalog = load_agent_catalog().expect("bundled catalog should validate");
        let first = catalog
            .agents
            .iter()
            .min_by_key(|agent| agent.auto_pick_rank)
            .expect("catalog is not empty");
        assert_eq!(first.id, "bluechip");
    }
}
