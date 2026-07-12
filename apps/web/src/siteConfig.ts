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
  accounts: [
    { name: "Coinbase", market: "Bitcoin and Ethereum", status: "Planned first connection" },
    { name: "Kalshi", market: "Event markets", status: "Planned for eligible accounts" },
    { name: "Polymarket", market: "Event markets", status: "Eligible regions only" },
    { name: "Robinhood", market: "Stocks", status: "Pending written platform approval" },
  ],
} as const;
