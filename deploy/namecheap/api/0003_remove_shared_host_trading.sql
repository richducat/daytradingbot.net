-- Remove the retired shared-host trading schema.
-- Real and Practice trading data belongs only on the customer's device.

SET NAMES utf8mb4;
SET time_zone = '+00:00';

DROP TABLE IF EXISTS web_trade_fills;
DROP TABLE IF EXISTS web_trade_intents;
DROP TABLE IF EXISTS web_real_authorizations;
DROP TABLE IF EXISTS web_worker_status;
DROP TABLE IF EXISTS web_trading_activity;
DROP TABLE IF EXISTS web_trading_settings;
DROP TABLE IF EXISTS web_trading_connections;
DROP TABLE IF EXISTS web_oauth_states;
