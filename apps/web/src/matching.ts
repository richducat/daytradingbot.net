export type TradingGoal = "learn" | "save_time" | "use_rules" | "fast_returns";
export type MarketChoice = "stocks" | "crypto" | "events" | "unsure";
export type ApproachChoice =
  | "pullbacks"
  | "public_data"
  | "news"
  | "momentum"
  | "market_activity"
  | "unsure";
export type AccountChoice =
  | "robinhood_agentic"
  | "robinhood"
  | "coinbase"
  | "kalshi"
  | "polymarket"
  | "none";
export type ExperienceChoice = "new" | "some" | "active";
export type ReviewChoice = "daily" | "few_times_week" | "rarely";
export type DailyBudgetChoice = "5" | "10" | "25";
export type StartChoice = "practice" | "real_later" | "real_now";

export type MatchAnswers = {
  goal: TradingGoal;
  market: MarketChoice;
  approach: ApproachChoice;
  account: AccountChoice;
  experience: ExperienceChoice;
  reviewFrequency: ReviewChoice;
  dailyBudget: DailyBudgetChoice;
  startPreference: StartChoice;
};

export type AgentName =
  | "Bluechip"
  | "Stormfront"
  | "Barometer"
  | "Oracle Gap"
  | "Smart Money"
  | "News Watch"
  | "Sprinter"
  | "Last Call"
  | "X Pulse";

export type MatchResult = {
  status: "available" | "coming_soon";
  agent: AgentName;
  title: string;
  summary: string;
  reason: string;
  accountNeeded: string;
  recommendedMode: "Practice" | "Real after Practice";
  dailyLimit: number;
  perTradeLimit: number;
  needsAccountSetup: boolean;
  realTradingCaution: string | null;
};

const accountLabels: Record<AccountChoice, string> = {
  robinhood_agentic: "your Robinhood Agentic account",
  robinhood: "a dedicated Robinhood Agentic account",
  coinbase: "your Coinbase account",
  kalshi: "your Kalshi account",
  polymarket: "your approved Polymarket US account",
  none: "a supported account opened in your own name",
};

const summaries: Record<AgentName, string> = {
  Bluechip: "Watches a short list of widely held stocks and ETFs for meaningful pullbacks.",
  Stormfront: "Compares weather-market prices with current public forecasts.",
  Barometer: "Compares Kalshi weather contracts with current public forecasts.",
  "Oracle Gap": "Looks for gaps between event-market prices and a group of AI forecasts.",
  "Smart Money": "Tracks selected prediction-market activity for repeatable patterns.",
  "News Watch": "Watches trusted news sources for events that can move prediction markets.",
  Sprinter: "Looks for short bursts of momentum in fast Bitcoin and crypto markets.",
  "Last Call": "Looks for carefully priced opportunities shortly before a market settles.",
  "X Pulse": "Tracks social activity for markets tied to posting volume and attention.",
};

function eventAgent(answers: MatchAnswers): AgentName {
  if (answers.approach === "public_data") {
    return answers.account === "kalshi" ? "Barometer" : "Stormfront";
  }
  if (answers.approach === "news") return "News Watch";
  if (answers.approach === "market_activity") return "Smart Money";
  if (answers.approach === "momentum") return "X Pulse";
  if (answers.account === "kalshi") return "Barometer";
  if (answers.account === "polymarket") return "Stormfront";
  return "Oracle Gap";
}

function selectAgent(answers: MatchAnswers): AgentName {
  if (answers.market === "stocks") return "Bluechip";
  if (answers.market === "crypto") return "Sprinter";
  if (answers.market === "events") return eventAgent(answers);

  if (answers.account === "robinhood" || answers.account === "robinhood_agentic") {
    return "Bluechip";
  }
  if (answers.account === "coinbase") return "Sprinter";
  if (answers.account === "kalshi" || answers.account === "polymarket") {
    return eventAgent(answers);
  }
  if (answers.approach === "pullbacks") return "Bluechip";
  if (answers.approach === "momentum") return "Sprinter";
  return "Bluechip";
}

function riskPlan(answers: MatchAnswers): { dailyLimit: number; perTradeLimit: number } {
  const requested = Number(answers.dailyBudget);
  const experienceMaximum = answers.experience === "new" ? 5 : answers.experience === "some" ? 10 : 25;
  const dailyLimit = Math.min(requested, experienceMaximum);
  const perTradeLimit = dailyLimit <= 5 ? 1 : dailyLimit <= 10 ? 2 : 5;
  return { dailyLimit, perTradeLimit };
}

function requiredAccount(agent: AgentName): string {
  if (agent === "Bluechip") return "Robinhood Agentic";
  if (agent === "Sprinter") return "Coinbase or an approved supported crypto connection";
  if (agent === "Barometer") return "Kalshi";
  if (agent === "Stormfront" || agent === "Smart Money" || agent === "News Watch" || agent === "Last Call" || agent === "X Pulse") {
    return "an approved Polymarket US account";
  }
  return "Kalshi or an approved Polymarket US account";
}

function hasRequiredAccount(agent: AgentName, account: AccountChoice): boolean {
  if (agent === "Bluechip") return account === "robinhood_agentic";
  if (agent === "Sprinter") return account === "coinbase";
  if (agent === "Barometer") return account === "kalshi";
  if (agent === "Oracle Gap") return account === "kalshi" || account === "polymarket";
  return account === "polymarket";
}

export function recommendAgent(answers: MatchAnswers): MatchResult {
  const { dailyLimit, perTradeLimit } = riskPlan(answers);
  const agent = selectAgent(answers);
  const available = agent === "Bluechip";
  const needsAccountSetup = !hasRequiredAccount(agent, answers.account);
  const mustStartInPractice =
    answers.experience === "new"
    || answers.reviewFrequency === "rarely"
    || answers.startPreference === "real_now";
  const recommendedMode = mustStartInPractice ? "Practice" : "Real after Practice";
  const cautions: string[] = [];
  if (answers.goal === "fast_returns") {
    cautions.push("Short-term opportunities can also mean faster losses. We suggest starting small and trying Practice first.");
  }
  if (answers.reviewFrequency === "rarely") {
    cautions.push("Because you plan to check in rarely, we suggest staying in Practice until regular reviews fit your schedule.");
  } else if (answers.startPreference === "real_now") {
    cautions.push("You want to use real money right away. We suggest a Practice run first so you can see what the bot does.");
  }
  const realTradingCaution = cautions.length > 0 ? `${cautions.join(" ")} The final choice is yours.` : null;

  return {
    status: available ? "available" : "coming_soon",
    agent,
    title: available ? `${agent} fits your answers best.` : `${agent} fits your answers best—but it is not released yet.`,
    summary: summaries[agent],
    reason: answers.market === "unsure"
      ? `We used your goal, preferred strategy, and ${accountLabels[answers.account]} to make this suggestion.`
      : `We used your market, preferred strategy, experience, and current account to make this suggestion.` ,
    accountNeeded: requiredAccount(agent),
    recommendedMode,
    dailyLimit,
    perTradeLimit,
    needsAccountSetup,
    realTradingCaution,
  };
}

const validValues = {
  goal: ["learn", "save_time", "use_rules", "fast_returns"],
  market: ["stocks", "crypto", "events", "unsure"],
  approach: ["pullbacks", "public_data", "news", "momentum", "market_activity", "unsure"],
  account: ["robinhood_agentic", "robinhood", "coinbase", "kalshi", "polymarket", "none"],
  experience: ["new", "some", "active"],
  reviewFrequency: ["daily", "few_times_week", "rarely"],
  dailyBudget: ["5", "10", "25"],
  startPreference: ["practice", "real_later", "real_now"],
} as const;

export function isCompleteAnswers(value: Partial<MatchAnswers>): value is MatchAnswers {
  return (Object.keys(validValues) as Array<keyof MatchAnswers>).every((key) => {
    const allowed = validValues[key] as readonly string[];
    return typeof value[key] === "string" && allowed.includes(value[key]);
  });
}
