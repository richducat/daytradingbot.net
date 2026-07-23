import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { useEffect, useMemo, useState } from "react";
import {
  isCompleteAnswers,
  recommendAgent,
  type MatchAnswers,
  type MatchResult,
} from "./matching";
import { siteConfig } from "./siteConfig";

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
  disclosure: boolean;
  terms: boolean;
  choice: boolean;
};

type StoredIntake = {
  answers: Partial<MatchAnswers>;
  confirmations: Confirmations;
  step: number;
};

const emptyConfirmations: Confirmations = {
  losses: false,
  disclosure: false,
  terms: false,
  choice: false,
};

const questions: Question[] = [
  {
    key: "goal",
    eyebrow: "What you want",
    title: "What would make a trading bot useful to you?",
    help: "Pick the closest answer. This isn't a test.",
    why: "Why we ask: your main reason for using a bot helps us choose the right starting setup.",
    options: [
      { value: "learn", label: "See how a bot trades before I use money", detail: "I want a Practice run I can watch and review." },
      { value: "save_time", label: "Stop watching charts all day", detail: "I want the bot checking the market while I do other things." },
      { value: "use_rules", label: "Stick to a plan instead of trading on impulse", detail: "I want the same rule and dollar limits followed every time." },
      { value: "fast_returns", label: "Look for short-term setups", detail: "I am interested in faster trades and understand they can also lose money faster." },
    ],
  },
  {
    key: "market",
    eyebrow: "Where it looks",
    title: "Which market do you want the bot watching?",
    help: "Each market needs a different bot and account connection.",
    why: "Why we ask: this tells us which bot could actually work with the market you want.",
    options: [
      { value: "stocks", label: "Stocks and ETFs", detail: "Companies and funds traded through Robinhood. Bluechip is available for this now." },
      { value: "crypto", label: "Bitcoin and crypto", detail: "Faster-moving crypto markets through a supported exchange." },
      { value: "events", label: "Prediction and event markets", detail: "Weather, news, and event contracts on Kalshi or Polymarket US." },
      { value: "unsure", label: "Pick for me", detail: "Use the rest of my answers to choose the clearest fit." },
    ],
  },
  {
    key: "approach",
    eyebrow: "How it decides",
    title: "Which trading idea makes the most sense to you?",
    help: "You don't need trader vocabulary. Choose the explanation you would feel comfortable reviewing later.",
    why: "Why we ask: even when the bot does the work, you should understand why it acts.",
    options: [
      { value: "pullbacks", label: "Buy a pullback", detail: "Watch for an established stock or fund dropping by a set amount." },
      { value: "public_data", label: "Trade from public data", detail: "Compare a market price with weather forecasts or other public information." },
      { value: "news", label: "React to confirmed news", detail: "Watch trusted sources for an event that could change a market." },
      { value: "momentum", label: "Follow a fast-moving price", detail: "Look for a short burst of price or attention." },
      { value: "market_activity", label: "Follow experienced traders", detail: "Watch selected market participants for a repeatable pattern." },
      { value: "unsure", label: "Pick for me", detail: "Choose the clearest match from my market and account answers." },
    ],
  },
  {
    key: "account",
    eyebrow: "Where your money stays",
    title: "Where do you already trade?",
    help: "You never move trading money to DayTradingBot. It stays in the account you control.",
    why: "Why we ask: a bot can only run through an account it supports.",
    options: [
      { value: "robinhood_agentic", label: "Robinhood Agentic", detail: "I already have Robinhood's separate account for authorized trading apps." },
      { value: "robinhood", label: "Robinhood", detail: "I use Robinhood but haven't created its Agentic account yet." },
      { value: "coinbase", label: "Coinbase", detail: "I trade crypto through a Coinbase account I control." },
      { value: "kalshi", label: "Kalshi", detail: "I have an eligible Kalshi account." },
      { value: "polymarket", label: "Polymarket US", detail: "I have an approved U.S. retail account." },
      { value: "none", label: "I don't have one yet", detail: "Show me which account the suggested bot needs." },
    ],
  },
  {
    key: "experience",
    eyebrow: "How hands-on you are",
    title: "How much trading have you done yourself?",
    help: "This changes the starting amount and mode we suggest, not what you are allowed to use.",
    why: "Why we ask: someone still learning may want a smaller first setup than someone who trades every week.",
    options: [
      { value: "new", label: "I'm learning", detail: "I am still getting comfortable with orders, positions, and losses." },
      { value: "some", label: "I've placed trades", detail: "I know how to buy and sell and understand that losses happen." },
      { value: "active", label: "I trade often", detail: "I regularly manage positions and decide how much money to risk." },
    ],
  },
  {
    key: "reviewFrequency",
    eyebrow: "How often you will look",
    title: "Realistically, how often will you check the app?",
    help: "Activity shows every check, skipped trade, and order so you can see what happened while you were away.",
    why: "Why we ask: if you won't review it often, Practice is a better place to begin.",
    options: [
      { value: "daily", label: "Every trading day", detail: "I can review Activity and account notices daily." },
      { value: "few_times_week", label: "A few times a week", detail: "I will check regularly, just not every day." },
      { value: "rarely", label: "Only once in a while", detail: "I want to turn it on and leave it alone for long stretches." },
    ],
  },
  {
    key: "dailyBudget",
    eyebrow: "Your hard dollar limit",
    title: "What is the most it may put into new trades in one day?",
    help: "This is a ceiling. Choosing $10 doesn't mean the bot must spend $10.",
    why: "Why we ask: your answer gives us a concrete starting setup instead of handing you an empty box.",
    options: [
      { value: "5", label: "$5 a day", detail: "A small starting suggestion. You can choose another amount in the app." },
      { value: "10", label: "$10 a day", detail: "A middle starting suggestion that can be changed before trading." },
      { value: "25", label: "$25 a day", detail: "A larger starting suggestion. Your actual limit is your choice and cannot exceed available buying power." },
    ],
  },
  {
    key: "startPreference",
    eyebrow: "Watch it or let it trade",
    title: "How would you feel most comfortable starting?",
    help: "Practice uses current market information and shows the decision without placing an order.",
    why: "Why we ask: we will recommend a first mode, but the final choice is yours.",
    options: [
      { value: "practice", label: "Let me watch it first", detail: "I want to understand the decisions before any real order." },
      { value: "real_later", label: "Practice first, then I may go Real", detail: "I want to review Activity before I use real money." },
      { value: "real_now", label: "I want the option to trade right away", detail: "I would prefer to skip Practice after I read the risks and set my limits." },
    ],
  },
];

const storageKey = "daytradingbot-intake-v2";

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

function MatchView({ result, onEdit, onReset }: { result: MatchResult; onEdit: () => void; onReset: () => void }) {
  const available = result.status === "available";
  const [startingCheckout, setStartingCheckout] = useState(false);
  const [checkoutError, setCheckoutError] = useState("");

  async function startCheckout() {
    if (startingCheckout) return;
    setStartingCheckout(true);
    setCheckoutError("");
    track("checkout_started", { suggestedAgent: result.agent });
    try {
      const response = await fetch(`${siteConfig.apiBaseUrl}/v1/checkout/session`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ acceptedRiskDisclosure: true }),
      });
      const payload = await response.json() as { checkoutUrl?: unknown; message?: unknown };
      if (!response.ok || typeof payload.checkoutUrl !== "string") {
        throw new Error(typeof payload.message === "string" ? payload.message : "checkout_unavailable");
      }
      const checkoutUrl = new URL(payload.checkoutUrl);
      if (checkoutUrl.protocol !== "https:" || checkoutUrl.hostname !== "checkout.stripe.com") {
        throw new Error("invalid_checkout_url");
      }
      window.location.assign(checkoutUrl.toString());
    } catch (caught) {
      setStartingCheckout(false);
      setCheckoutError(caught instanceof Error && caught.message !== "checkout_unavailable"
        ? caught.message
        : "Checkout could not start. Please try again. If it keeps happening, email support@daytradingbot.net.");
    }
  }

  return (
    <main className="match-result">
      <header className="intake-header">
        <a className="wordmark" href="/">DAYTRADINGBOT</a>
        <span>Your starting setup</span>
      </header>
      <section className="match-hero">
        <p className="eyebrow">Based on what you told us</p>
        <h1>{result.title}</h1>
        <p className="match-lead">{result.summary}</p>
        <p className="match-choice">This is yours to change. You can edit the answers or choose a different released bot.</p>
      </section>

      <section className="match-plan" aria-labelledby="plan-heading">
        <div className="match-plan-intro">
          <p className="eyebrow">Your day-one setup</p>
          <h2 id="plan-heading">Here is where we would begin.</h2>
          <p>{result.reason} You can change every setting before the bot runs.</p>
        </div>
        <dl className="plan-rows">
          <div><dt>Bot</dt><dd>{result.agent}</dd></div>
          <div><dt>Connects to</dt><dd>{result.accountNeeded}</dd></div>
          <div><dt>Start in</dt><dd>{result.recommendedMode}</dd></div>
          <div><dt>Most in one trade</dt><dd>${result.perTradeLimit}</dd></div>
          <div><dt>Most in new trades today</dt><dd>${result.dailyLimit}</dd></div>
        </dl>
      </section>

      {(result.needsAccountSetup || result.realTradingCaution) && (
        <section className="match-notices" aria-label="Helpful notes">
          {result.needsAccountSetup && <p><strong>You will need the right account.</strong> {result.agent} uses {result.accountNeeded}. You can set it up later or choose another released bot.</p>}
          {result.realTradingCaution && <p><strong>Why we picked this starting mode.</strong> {result.realTradingCaution}</p>}
        </section>
      )}

      <section className="after-match">
        <div>
          <p className="eyebrow">What happens after checkout</p>
          <h2>Your first Practice run takes four steps.</h2>
        </div>
        <ol>
          <li><span>01</span><div><strong>Get your access code and Mac download</strong><p>Both appear after Stripe confirms payment and are also sent by email.</p></div></li>
          <li><span>02</span><div><strong>Open the Mac app</strong><p>Install DayTradingBot on the Mac you will use and enter your access code once.</p></div></li>
          <li><span>03</span><div><strong>Connect Robinhood inside the app</strong><p>Robinhood handles approval. Your connection stays on your Mac, and your trading money stays at Robinhood.</p></div></li>
          <li><span>04</span><div><strong>Choose limits and start Practice</strong><p>Pick the dollars per trade and per day. Move to Real only if and when you choose.</p></div></li>
        </ol>
      </section>

      <section className="match-checkout">
        <div>
          <p className="eyebrow">{available ? "One-time price" : "An honest answer"}</p>
          <h2>{available ? "One payment. Bluechip is yours to use on one Mac." : `${result.agent} is not for sale yet. Bluechip is.`}</h2>
          <p>{available
            ? "The $98 license includes the Mac app, Bluechip, Practice, Real trading controls, guided setup, Activity, and version 1 updates. Your trading money stays in Robinhood."
            : `Based on your answers, ${result.agent} fits better than Bluechip. If you also want a Robinhood stock bot, you may still choose Bluechip. We will not pretend it is the same strategy.`}</p>
          <a className="text-link dark-link" href="/#example">See exactly what Bluechip does <span aria-hidden="true">→</span></a>
        </div>
        <div className="checkout-action">
          <button
            type="button"
            className="button offer-button"
            onClick={() => void startCheckout()}
            disabled={startingCheckout}
          >
            {startingCheckout ? "Opening secure checkout…" : available ? "Get Bluechip for $98" : "Choose Bluechip instead for $98"}
          </button>
          <small>Stripe handles payment. Your access code and Mac download appear after payment is confirmed.</small>
          {checkoutError && <p className="checkout-error" role="alert">{checkoutError}</p>}
        </div>
      </section>

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

  const isConfirmationStep = step === questions.length;
  const question = questions[step];
  const selected = question ? answers[question.key] : undefined;
  const allConfirmed = confirmations.losses && confirmations.disclosure && confirmations.terms && confirmations.choice;
  const canContinue = isConfirmationStep ? allConfirmed : Boolean(selected);

  useEffect(() => {
    document.title = showResult
      ? "Your starting setup | DayTradingBot"
      : "Build my trading-bot setup | DayTradingBot";
  }, [showResult]);

  useEffect(() => {
    window.localStorage.setItem(storageKey, JSON.stringify({ answers, confirmations, step } satisfies StoredIntake));
  }, [answers, confirmations, step]);

  const result = useMemo(() => {
    return isCompleteAnswers(answers) ? recommendAgent(answers) : null;
  }, [answers]);

  if (showResult && result) {
    return (
      <MatchView
        result={result}
        onEdit={() => {
          setShowResult(false);
          setStep(questions.length);
        }}
        onReset={() => {
          window.localStorage.removeItem(storageKey);
          setAnswers({});
          setConfirmations(emptyConfirmations);
          setStep(0);
          setShowResult(false);
          track("agent_match_restarted");
        }}
      />
    );
  }

  function continueIntake() {
    if (!canContinue) return;
    if (isConfirmationStep) {
      if (!isCompleteAnswers(answers)) return;
      const match = recommendAgent(answers);
      track("agent_match_completed", { status: match.status, agent: match.agent });
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
          <p className="eyebrow">Your two-minute setup</p>
          <h2>Let's make this fit your life and your comfort level.</h2>
          <ul>
            <li>See a complete setup before checkout</li>
            <li>One question at a time</li>
            <li>Change any answer</li>
            <li>No Social Security number or phone number</li>
            <li>No broker password or deposit</li>
          </ul>
          <p>Your answers stay in this browser. We use them only to build the result you see on screen.</p>
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
                  <p className="eyebrow">One last check</p>
                  <h1>Make sure you know what you are buying.</h1>
                  <p className="question-help">This is where we slow down for 30 seconds. Nothing here changes the bot based on how you answered.</p>
                  <div className="confirmation-list">
                    <label>
                      <input type="checkbox" checked={confirmations.losses} onChange={(event) => setConfirmations((current) => ({ ...current, losses: event.target.checked }))} />
                      <span><strong>I know real trades can lose money.</strong><small>Practice decisions cannot predict what a future real trade will earn or lose.</small></span>
                    </label>
                    <label>
                      <input type="checkbox" checked={confirmations.disclosure} onChange={(event) => setConfirmations((current) => ({ ...current, disclosure: event.target.checked }))} />
                      <span><strong>I read the <a href="/risk-disclosure/" target="_blank" rel="noreferrer">risk disclosure</a>.</strong><small>It covers trading losses, account responsibility, and software failures.</small></span>
                    </label>
                    <label>
                      <input type="checkbox" checked={confirmations.terms} onChange={(event) => setConfirmations((current) => ({ ...current, terms: event.target.checked }))} />
                      <span><strong>I read the <a href="/terms/" target="_blank" rel="noreferrer">software license terms</a>.</strong><small>The $98 payment buys software. Trading money and account costs are separate.</small></span>
                    </label>
                    <label>
                      <input type="checkbox" checked={confirmations.choice} onChange={(event) => setConfirmations((current) => ({ ...current, choice: event.target.checked }))} />
                      <span><strong>I know this setup is mine to change.</strong><small>I choose the bot, account, dollar limits, and whether to use Practice or Real.</small></span>
                    </label>
                  </div>
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
              {isConfirmationStep ? "Show me my setup" : "Continue"}
            </button>
          </div>
        </section>
      </div>
    </main>
  );
}
