export const siteConfig = {
  founderPrice: 98,
  founderSeats: 10,
  limits: {
    maxOpeningOrderUsd: 5,
    maxDailyOpeningNotionalUsd: 25,
    maxVenueExposureUsd: 100,
    maxGlobalExposureUsd: 200,
    maxDailyLossUsd: 10,
  },
  venues: [
    { name: "Robinhood", scope: "Long equities", gate: "Written integration clearance required" },
    { name: "Coinbase", scope: "BTC and ETH spot", gate: "View + trade keys; transfers rejected" },
    { name: "Kalshi", scope: "Event contracts", gate: "Account eligibility verified locally" },
    { name: "Polymarket", scope: "Eligible regions only", gate: "Geoblock checked before each order" },
  ],
} as const;

