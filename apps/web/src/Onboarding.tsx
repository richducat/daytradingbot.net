import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { useEffect, useMemo, useState } from "react";
import {
  isCompleteAnswers,
  recommendAgent,
  type MatchAnswers,
  type MatchResult,
} from "./matching";

type AnswerKey = keyof MatchAnswers;

type QuestionOption = {
  value: string;
  label: string;
  detail: string;
};

type Question = {
  key: AnswerKey;
  eyebrow: string;
  title: string;
  help: string;
  why: string;
  options: QuestionOption[];
};

type Confirmations = {
  losses: boolean;
  essentials: boolean;
  ownership: boolean;
};

type StoredIntake = {
  answers: Partial<MatchAnswers>;
  confirmations: Confirmations;
  step: number;
};

const emptyConfirmations: Confirmations = {
  losses: false,
  essentials: false,
  ownership: false,
};

const questions: Question[] = [
  {
    key: "goal",
    eyebrow: "Your goal",
    title: "What do you actually want help with?",
    help: "Choose the closest answer. This is the first place we may decide the product is not right for you.",
    why: "Why we ask: an agent can automate a process. It cannot make returns predictable.",
    options: [
      { value: "learn", label: "Learn before I risk money", detail: "I want to watch what an agent would do in Practice." },
      { value: "save_time", label: "Spend less time watching markets", detail: "I want software to check a defined market for me." },
      { value: "use_rules", label: "Put firm rules around my trading", detail: "I want fixed limits and a repeatable approach." },
      { value: "fast_returns", label: "Make fast or guaranteed money", detail: "I expect the AI to reliably produce a profit." },
    ],
  },
  {
    key: "market",
    eyebrow: "The market",
    title: "Where do you want an agent to look?",
    help: "Different agents use different accounts, information, and trading approaches.",
    why: "Why we ask: this determines which agents and account connections can work for you.",
    options: [
      { value: "stocks", label: "Stocks and ETFs", detail: "Companies and funds traded through Robinhood." },
      { value: "crypto", label: "Bitcoin and crypto", detail: "Short-term crypto opportunities through a supported exchange." },
      { value: "events", label: "Prediction and event markets", detail: "Weather, news, and event contracts on Kalshi or Polymarket US." },
      { value: "unsure", label: "I am not sure yet", detail: "Use my other answers to narrow this down." },
    ],
  },
  {
    key: "approach",
    eyebrow: "The approach",
    title: "Which kind of signal makes the most sense to you?",
    help: "You do not need to know trading terminology. Pick the explanation you are most comfortable following.",
    why: "Why we ask: you should understand the basic reason an agent acts, even when the software does the work.",
    options: [
      { value: "pullbacks", label: "Price pullbacks", detail: "Look for established stocks or funds that have dropped by a defined amount." },
      { value: "public_data", label: "Public data and forecasts", detail: "Compare market prices with weather forecasts or other public data." },
      { value: "news", label: "Trusted news", detail: "Watch for verified events that can change a market." },
      { value: "momentum", label: "Short-term momentum", detail: "Look for fast price or attention changes." },
      { value: "market_activity", label: "Experienced market activity", detail: "Watch selected market participants for repeatable patterns." },
      { value: "unsure", label: "Pick the clearest fit for me", detail: "Use my market and account answers to decide." },
    ],
  },
  {
    key: "account",
    eyebrow: "Your account",
    title: "Which account could the app connect to?",
    help: "Your money stays with that company. DayTradingBot does not accept deposits or hold customer funds.",
    why: "Why we ask: we will not recommend an agent that cannot connect to an account you can actually use.",
    options: [
      { value: "robinhood_agentic", label: "Robinhood Agentic account", detail: "I already have Robinhood's dedicated account for an agent." },
      { value: "robinhood", label: "Regular Robinhood account", detail: "I use Robinhood but have not set up an Agentic account." },
      { value: "coinbase", label: "Coinbase", detail: "I have a Coinbase account I control." },
      { value: "kalshi", label: "Kalshi", detail: "I have an eligible Kalshi account I control." },
      { value: "polymarket", label: "Polymarket US", detail: "I have an approved U.S. retail account." },
      { value: "none", label: "None of these yet", detail: "I would need clear account setup instructions." },
    ],
  },
  {
    key: "experience",
    eyebrow: "Your experience",
    title: "How much trading experience do you have?",
    help: "This changes the starting amount and whether we insist on Practice first.",
    why: "Why we ask: a new customer should not receive the same starting plan as an experienced active trader.",
    options: [
      { value: "new", label: "New", detail: "I am still learning how orders, positions, and losses work." },
      { value: "some", label: "Some experience", detail: "I have placed trades and understand that losses happen." },
      { value: "active", label: "Active trader", detail: "I regularly manage trades, positions, and account risk." },
    ],
  },
  {
    key: "reviewFrequency",
    eyebrow: "Your involvement",
    title: "How often will you review the app's activity?",
    help: "Automation still needs an owner. Pause, rejected orders, and account notices should not be ignored.",
    why: "Why we ask: people who will not review activity should not start with real money.",
    options: [
      { value: "daily", label: "At least once each trading day", detail: "I can check activity and account notices daily." },
      { value: "few_times_week", label: "A few times each week", detail: "I can review the app regularly, but not constantly." },
      { value: "rarely", label: "Rarely", detail: "I want to turn it on and leave it alone for long periods." },
    ],
  },
  {
    key: "dailyBudget",
    eyebrow: "Your dollar limit",
    title: "What is the most the app may put into new trades in one day?",
    help: "This is a ceiling, not a target. The agent may use less or place no trade at all.",
    why: "Why we ask: your match should arrive with a specific starting limit—not an empty box asking you to guess.",
    options: [
      { value: "5", label: "$5 per day", detail: "The smallest starting plan." },
      { value: "10", label: "$10 per day", detail: "A modest plan for someone with prior experience." },
      { value: "25", label: "$25 per day", detail: "The built-in customer maximum; never required." },
    ],
  },
  {
    key: "startPreference",
    eyebrow: "Practice or Real",
    title: "How do you expect to begin?",
    help: "Practice uses current market information and records what the agent would do without placing an order.",
    why: "Why we ask: choosing Real immediately may cause us to recommend Practice anyway.",
    options: [
      { value: "practice", label: "Practice first", detail: "I want to understand the agent before any real order." },
      { value: "real_later", label: "Practice, then consider Real", detail: "I may use real money after I review the activity." },
      { value: "real_now", label: "Real money immediately", detail: "I would prefer to skip Practice." },
    ],
  },
];

const storageKey = "daytradingbot-intake-v1";

function readStoredIntake(): StoredIntake {
  try {
    const raw = window.localStorage.getItem(storageKey);
    if (!raw) return { answers: {}, confirmations: emptyConfirmations, step: 0 };
    const parsed = JSON.parse(raw) as Partial<StoredIntake>;
    return {
      answers: parsed.answers ?? {},
      confirmations: { ...emptyConfirmations, ...parsed.confirmations },
      step: typeof parsed.step === "number" && parsed.step >= 0 && parsed.step <= questions.length
        ? parsed.step
        : 0,
    };
  } catch {
    return { answers: {}, confirmations: emptyConfirmations, step: 0 };
  }
}

function track(event: string, details: Record<string, string | number> = {}) {
  const target = window as Window & { dataLayer?: Array<Record<string, string | number>> };
  target.dataLayer?.push({ event, ...details });
}

function stoppedResult(reason: "fast_returns" | "essentials"): MatchResult {
  if (reason === "fast_returns") {
    return {
      status: "not_fit",
      agent: null,
      title: "DayTradingBot is not a fit for that goal.",
      summary: "No trading agent can promise fast or guaranteed money, and we will not take payment from someone expecting that.",
      reason: "The product automates a defined process. It does not remove market risk or make returns predictable.",
      accountNeeded: "None",
      recommendedMode: "Practice",
      dailyLimit: 0,
      perTradeLimit: 0,
      needsAccountSetup: false,
      realTradingCaution: null,
    };
  }
  return {
    status: "not_fit",
    agent: null,
    title: "DayTradingBot is not a fit right now.",
    summary: "You should not use automated trading with money needed for bills or essential expenses.",
    reason: "A dollar limit reduces exposure, but it cannot make a trade safe or prevent the full amount from being lost.",
    accountNeeded: "None",
    recommendedMode: "Practice",
    dailyLimit: 0,
    perTradeLimit: 0,
    needsAccountSetup: false,
    realTradingCaution: null,
  };
}

function MatchView({ result, onEdit, onReset }: { result: MatchResult; onEdit: () => void; onReset: () => void }) {
  const available = result.status === "available";

  return (
    <main className="match-result">
      <header className="intake-header">
        <a className="wordmark" href="/">DAYTRADINGBOT</a>
        <span>Fit review complete</span>
      </header>
      <section className="match-hero">
        <p className="eyebrow">{result.status === "not_fit" ? "Honest answer" : "Your agent match"}</p>
        <h1>{result.title}</h1>
        <p className="match-lead">{result.summary}</p>
      </section>

      {result.status === "not_fit" ? (
        <section className="not-fit-panel">
          <h2>Why we stopped here</h2>
          <p>{result.reason}</p>
          <p>Practice tools and general trading education may be more appropriate, but this software should not be purchased with an expectation of reliable profit.</p>
          <div className="result-actions">
            <button className="button button-secondary" type="button" onClick={onEdit}>Change my answer</button>
            <a className="text-link" href="/">Return home</a>
          </div>
        </section>
      ) : (
        <>
          <section className="match-plan" aria-labelledby="plan-heading">
            <div className="match-plan-intro">
              <p className="eyebrow">Your suggested starting plan</p>
              <h2 id="plan-heading">A setup you can understand before paying.</h2>
              <p>{result.reason}</p>
            </div>
            <dl className="plan-rows">
              <div><dt>Agent</dt><dd>{result.agent}</dd></div>
              <div><dt>Required account</dt><dd>{result.accountNeeded}</dd></div>
              <div><dt>Starting mode</dt><dd>{result.recommendedMode}</dd></div>
              <div><dt>Most in one trade</dt><dd>${result.perTradeLimit}</dd></div>
              <div><dt>Most in new trades per day</dt><dd>${result.dailyLimit}</dd></div>
            </dl>
          </section>

          {(result.needsAccountSetup || result.realTradingCaution) && (
            <section className="match-notices" aria-label="Before you start">
              {result.needsAccountSetup && <p><strong>Account setup needed.</strong> Your selected account is not the connection this agent requires. The app would guide you through the correct account before Start becomes available.</p>}
              {result.realTradingCaution && <p><strong>Practice required.</strong> {result.realTradingCaution}</p>}
            </section>
          )}

          <section className="after-match">
            <div>
              <p className="eyebrow">What would happen next</p>
              <h2>Payment comes after the fit decision.</h2>
            </div>
            <ol>
              <li><span>01</span><div><strong>Review this match</strong><p>See the agent, required account, starting mode, and exact dollar limits.</p></div></li>
              <li><span>02</span><div><strong>Purchase the desktop license</strong><p>Only available matches may continue. Trading money is never paid to DayTradingBot.</p></div></li>
              <li><span>03</span><div><strong>Install and connect</strong><p>Connect the supported account in the desktop app and confirm available funds there.</p></div></li>
              <li><span>04</span><div><strong>Start in Practice</strong><p>Review what the agent finds before deciding whether to enable Real trading.</p></div></li>
            </ol>
          </section>

          <section className="match-checkout">
            <div>
              <p className="eyebrow">{available ? "Potential founding fit" : "No payment will be shown"}</p>
              <h2>{available ? "$98 once, after final testing." : `${result.agent} is still being packaged for customers.`}</h2>
              <p>{available
                ? "Checkout remains closed today. When it opens, this completed match will be required before purchase."
                : "We will not sell you Bluechip merely because it is available when another agent better matches your answers."}</p>
            </div>
            <button className="button button-disabled" type="button" disabled>
              {available ? "Checkout opens after final testing" : "No purchase available for this match"}
            </button>
          </section>
        </>
      )}

      <footer className="result-footer">
        <button type="button" onClick={onEdit}>Edit my answers</button>
        <button type="button" onClick={onReset}>Start over</button>
        <span>These answers are saved only in this browser.</span>
      </footer>
    </main>
  );
}

export function Onboarding() {
  const reduceMotion = useReducedMotion();
  const initial = useMemo(readStoredIntake, []);
  const [answers, setAnswers] = useState<Partial<MatchAnswers>>(initial.answers);
  const [confirmations, setConfirmations] = useState<Confirmations>(initial.confirmations);
  const [step, setStep] = useState(initial.step);
  const [showResult, setShowResult] = useState(false);
  const [stopReason, setStopReason] = useState<"fast_returns" | "essentials" | null>(null);

  const isConfirmationStep = step === questions.length;
  const question = questions[step];
  const selected = question ? answers[question.key] : undefined;
  const allConfirmed = confirmations.losses && confirmations.essentials && confirmations.ownership;
  const canContinue = isConfirmationStep ? allConfirmed : Boolean(selected);

  useEffect(() => {
    document.title = showResult
      ? "Your agent match — DayTradingBot"
      : "Find my trading agent — DayTradingBot";
  }, [showResult]);

  useEffect(() => {
    window.localStorage.setItem(storageKey, JSON.stringify({ answers, confirmations, step } satisfies StoredIntake));
  }, [answers, confirmations, step]);

  const result = useMemo(() => {
    if (stopReason) return stoppedResult(stopReason);
    return isCompleteAnswers(answers) ? recommendAgent(answers) : null;
  }, [answers, stopReason]);

  if (showResult && result) {
    return (
      <MatchView
        result={result}
        onEdit={() => {
          setShowResult(false);
          setStep(stopReason === "essentials" ? questions.length : result.status === "not_fit" ? 0 : questions.length);
          setStopReason(null);
        }}
        onReset={() => {
          window.localStorage.removeItem(storageKey);
          setAnswers({});
          setConfirmations(emptyConfirmations);
          setStep(0);
          setShowResult(false);
          setStopReason(null);
          track("agent_match_restarted");
        }}
      />
    );
  }

  function continueIntake() {
    if (!canContinue) return;
    if (step === 0 && answers.goal === "fast_returns") {
      setStopReason("fast_returns");
      setShowResult(true);
      track("agent_match_stopped", { reason: "fast_returns" });
      window.scrollTo({ top: 0, behavior: reduceMotion ? "auto" : "smooth" });
      return;
    }
    if (isConfirmationStep) {
      if (!isCompleteAnswers(answers)) return;
      const match = recommendAgent(answers);
      track("agent_match_completed", { status: match.status, agent: match.agent ?? "none" });
      setShowResult(true);
      window.scrollTo({ top: 0, behavior: reduceMotion ? "auto" : "smooth" });
      return;
    }
    track("agent_match_step_completed", { step: step + 1 });
    setStep((current) => Math.min(current + 1, questions.length));
  }

  return (
    <main className="intake-page">
      <header className="intake-header">
        <a className="wordmark" href="/">DAYTRADINGBOT</a>
        <a href="/">Save and exit</a>
      </header>

      <div className="intake-progress" aria-label={`Step ${step + 1} of ${questions.length + 1}`}>
        <div
          role="progressbar"
          aria-valuemin={1}
          aria-valuemax={questions.length + 1}
          aria-valuenow={step + 1}
          style={{ width: `${((step + 1) / (questions.length + 1)) * 100}%` }}
        />
      </div>

      <div className="intake-layout">
        <aside className="intake-assurance">
          <p className="eyebrow">Find my agent</p>
          <h2>We would rather say no than sell the wrong setup.</h2>
          <ul>
            <li>About two minutes</li>
            <li>One question at a time</li>
            <li>No Social Security number</li>
            <li>No account password or deposit</li>
            <li>No payment before the result</li>
          </ul>
          <p>Your answers stay in this browser during pre-launch testing.</p>
        </aside>

        <section className="intake-question" aria-live="polite">
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              className="question-panel"
              key={step}
              initial={reduceMotion ? false : { opacity: 0, x: 24 }}
              animate={{ opacity: 1, x: 0 }}
              exit={reduceMotion ? undefined : { opacity: 0, x: -18 }}
              transition={{ duration: 0.22 }}
            >
              <p className="step-label">Step {step + 1} of {questions.length + 1}</p>
              {isConfirmationStep ? (
                <>
                  <p className="eyebrow">Before your result</p>
                  <h1>Confirm the three things we will not assume.</h1>
                  <p className="question-help">All three are required for a match. If one is not true, we should stop before payment.</p>
                  <div className="confirmation-list">
                    <label>
                      <input type="checkbox" checked={confirmations.losses} onChange={(event) => setConfirmations((current) => ({ ...current, losses: event.target.checked }))} />
                      <span><strong>I understand every agent can lose money.</strong><small>No strategy, AI model, or Practice result guarantees a future profit.</small></span>
                    </label>
                    <label>
                      <input type="checkbox" checked={confirmations.essentials} onChange={(event) => setConfirmations((current) => ({ ...current, essentials: event.target.checked }))} />
                      <span><strong>The amount I chose is not needed for essentials.</strong><small>Losing it would not prevent me from paying bills, food, housing, or other necessities.</small></span>
                    </label>
                    <label>
                      <input type="checkbox" checked={confirmations.ownership} onChange={(event) => setConfirmations((current) => ({ ...current, ownership: event.target.checked }))} />
                      <span><strong>I will connect only an account I own.</strong><small>I will review activity and remain responsible for my account and trades.</small></span>
                    </label>
                  </div>
                  <button
                    className="not-fit-link"
                    type="button"
                    onClick={() => {
                      setStopReason("essentials");
                      setShowResult(true);
                      track("agent_match_declined_suitability");
                    }}
                  >
                    I cannot confirm all three
                  </button>
                </>
              ) : question ? (
                <>
                  <p className="eyebrow">{question.eyebrow}</p>
                  <h1>{question.title}</h1>
                  <p className="question-help">{question.help}</p>
                  <div className="option-list" role="radiogroup" aria-label={question.title}>
                    {question.options.map((option) => {
                      const active = selected === option.value;
                      return (
                        <label
                          className={active ? "option-row selected" : "option-row"}
                          key={option.value}
                        >
                          <input
                            type="radio"
                            name={question.key}
                            value={option.value}
                            checked={active}
                            onChange={() => setAnswers((current) => ({ ...current, [question.key]: option.value }))}
                          />
                          <span className="option-radio" aria-hidden="true" />
                          <span><strong>{option.label}</strong><small>{option.detail}</small></span>
                        </label>
                      );
                    })}
                  </div>
                  <p className="why-ask">{question.why}</p>
                </>
              ) : null}
            </motion.div>
          </AnimatePresence>

          <div className="intake-actions">
            <button
              className="back-button"
              type="button"
              disabled={step === 0}
              onClick={() => setStep((current) => Math.max(0, current - 1))}
            >
              Back
            </button>
            <button className="button button-primary" type="button" disabled={!canContinue} onClick={continueIntake}>
              {isConfirmationStep ? "See my agent match" : "Continue"}
            </button>
          </div>
        </section>
      </div>
    </main>
  );
}
