export const siteConfig = {
  founderPrice: 98,
  apiBaseUrl: (import.meta.env.VITE_API_BASE_URL ?? "https://api.daytradingbot.net").replace(/\/$/, ""),
  macosDownloadUrl: import.meta.env.VITE_MACOS_DOWNLOAD_URL
    ?? "https://releases.daytradingbot.net/stable/DayTradingBot-macos-universal.dmg",
  supportEmail: "support@daytradingbot.net",
  accounts: [
    { name: "Robinhood", market: "Stocks and ETFs", status: "Bluechip Practice and Real are available in the Mac app" },
    { name: "Coinbase", market: "Bitcoin and Ethereum", status: "Account connection is ready; trading agent comes next" },
    { name: "Kalshi", market: "Event contracts", status: "Account connection is ready; agents come next" },
    { name: "Polymarket", market: "Prediction markets", status: "Approved U.S. account connection is ready; agents come next" },
  ],
  agents: [
    { name: "Bluechip", account: "Robinhood", market: "Stocks and ETFs", summary: "Looks for pullbacks in a short list of widely held stocks and funds.", available: true },
    { name: "Stormfront", account: "Polymarket", market: "Weather", summary: "Compares weather-market prices with current public forecasts.", available: false },
    { name: "Barometer", account: "Kalshi", market: "Weather", summary: "Compares Kalshi weather contracts with current public forecasts.", available: false },
    { name: "Oracle Gap", account: "Kalshi + Polymarket", market: "Event markets", summary: "Looks for gaps between market prices and a group of AI forecasts.", available: false },
    { name: "Smart Money", account: "Polymarket", market: "Prediction markets", summary: "Follows a selected group of experienced prediction-market traders.", available: false },
    { name: "News Watch", account: "Polymarket", market: "News", summary: "Watches trusted news sources for events that can move markets.", available: false },
    { name: "Sprinter", account: "Polymarket", market: "Short-term crypto", summary: "Looks for short bursts of momentum in fast Bitcoin and crypto markets.", available: false },
    { name: "Last Call", account: "Polymarket", market: "Near settlement", summary: "Looks for carefully priced opportunities shortly before a market settles.", available: false },
    { name: "X Pulse", account: "Polymarket", market: "Social media", summary: "Tracks posting activity for markets tied to social-media volume.", available: false },
  ],
} as const;
