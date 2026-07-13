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
  disclosure: boolean;
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
  choice: false,
};

const questions: Question[] = [
  {
    key: "goal",
    eyebrow: "Your goal",
    title: "What do you want the bot to help with?",
    help: "There is no wrong answer. This just helps us make a useful first suggestion.",
    why: "Why we ask: different goals call for different bots and starting settings.",
    options: [
      { value: "learn", label: "Learn before I risk money", detail: "I want to watch what a bot would do in Practice." },
      { value: "save_time", label: "Spend less time watching markets", detail: "I want software to check a defined market for me." },
      { value: "use_rules", label: "Put firm rules around my trading", detail: "I want fixed limits and a repeatable approach." },
      { value: "fast_returns", label: "Look for short-term opportunities", detail: "I want the bot focused on faster-moving setups, and I understand they can lose money." },
    ],
  },
  {
    key: "market",
    eyebrow: "The market",
    title: "Which market are you interested in?",
    help: "Different bots use different accounts, information, and trading strategies.",
    why: "Why we ask: this determines which bots and account connections can work for you.",
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
    title: "What kind of strategy sounds right to you?",
    help: "You do not need to know trading terminology. Pick the explanation you are most comfortable following.",
    why: "Why we ask: you should understand the basic reason a bot acts, even when the software does the work.",
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
    title: "Which account do you use?",
    help: "Your money stays with that company. DayTradingBot does not accept deposits or hold customer funds.",
    why: "Why we ask: each bot works with specific account connections. You can still choose a different released bot.",
    options: [
      { value: "robinhood_agentic", label: "Robinhood Agentic account", detail: "I already have Robinhood's dedicated account for automated trading." },
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
    title: "How familiar are you with trading?",
    help: "This helps us suggest a starting amount and whether to try Practice first.",
    why: "Why we ask: someone new may want a smaller starting suggestion than an active trader.",
    options: [
      { value: "new", label: "New", detail: "I am still learning how orders, positions, and losses work." },
      { value: "some", label: "Some experience", detail: "I have placed trades and understand that losses happen." },
      { value: "active", label: "Active trader", detail: "I regularly manage trades, positions, and account risk." },
    ],
  },
  {
    key: "reviewFrequency",
    eyebrow: "Your involvement",
    title: "How often do you want to check in?",
    help: "The app shows every action, skipped trade, and account message so you can review what happened.",
    why: "Why we ask: if you check in less often, we will suggest starting in Practice.",
    options: [
      { value: "daily", label: "At least once each trading day", detail: "I can check activity and account notices daily." },
      { value: "few_times_week", label: "A few times each week", detail: "I can review the app regularly, but not constantly." },
      { value: "rarely", label: "Rarely", detail: "I want to turn it on and leave it alone for long periods." },
    ],
  },
  {
    key: "dailyBudget",
    eyebrow: "Your dollar limit",
    title: "What is the most it can put into new trades each day?",
    help: "This is a ceiling, not a target. The bot may use less or place no trade at all.",
    why: "Why we ask: we can give you a clear starting suggestion instead of an empty box.",
    options: [
      { value: "5", label: "$5 per day", detail: "The smallest starting plan." },
      { value: "10", label: "$10 per day", detail: "A modest plan for someone with prior experience." },
      { value: "25", label: "$25 per day", detail: "The built-in customer maximum; never required." },
    ],
  },
  {
    key: "startPreference",
    eyebrow: "Practice or Real",
    title: "How do you want to start?",
    help: "Practice uses current market information and records what the bot would do without placing an order.",
    why: "Why we ask: we may suggest Practice first, but you make the final choice.",
    options: [
      { value: "practice", label: "Practice first", detail: "I want to understand the bot before any real order." },
      { value: "real_later", label: "Practice, then consider Real", detail: "I may use real money after I review the activity." },
      { value: "real_now", label: "Real money immediately", detail: "I would prefer to skip Practice." },
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

  return (
    <main className="match-result">
      <header className="intake-header">
        <a className="wordmark" href="/">DAYTRADINGBOT</a>
        <span>Your suggestion</span>
      </header>
      <section className="match-hero">
        <p className="eyebrow">Our suggestion—not a rule</p>
        <h1>{result.title}</h1>
        <p className="match-lead">{result.summary}</p>
        <p className="match-choice">This is a starting point. You can choose any released bot in the app.</p>
      </section>

      <section className="match-plan" aria-labelledby="plan-heading">
        <div className="match-plan-intro">
          <p className="eyebrow">A simple place to start</p>
          <h2 id="plan-heading">Here is the setup we would try first.</h2>
          <p>{result.reason} Change any of it before you start.</p>
        </div>
        <dl className="plan-rows">
          <div><dt>Suggested bot</dt><dd>{result.agent}</dd></div>
          <div><dt>Account it uses</dt><dd>{result.accountNeeded}</dd></div>
          <div><dt>Suggested way to start</dt><dd>{result.recommendedMode}</dd></div>
          <div><dt>Suggested amount per trade</dt><dd>${result.perTradeLimit}</dd></div>
          <div><dt>Suggested amount per day</dt><dd>${result.dailyLimit}</dd></div>
        </dl>
      </section>

      {(result.needsAccountSetup || result.realTradingCaution) && (
        <section className="match-notices" aria-label="Helpful notes">
          {result.needsAccountSetup && <p><strong>You may need a different account connection.</strong> {result.agent} uses {result.accountNeeded}. You can set that up later or choose another released bot.</p>}
          {result.realTradingCaution && <p><strong>Our starting suggestion.</strong> {result.realTradingCaution}</p>}
        </section>
      )}

      <section className="after-match">
        <div>
          <p className="eyebrow">You stay in charge</p>
          <h2>You decide what happens next.</h2>
        </div>
        <ol>
          <li><span>01</span><div><strong>Keep or change the bot</strong><p>Use this suggestion, edit your answers, or choose any released bot.</p></div></li>
          <li><span>02</span><div><strong>Read the fine print</strong><p>Real trades can lose money. The bot does not promise a profit.</p></div></li>
          <li><span>03</span><div><strong>Buy and connect</strong><p>Buy the desktop app, then connect an account you own. Trading money stays in that account.</p></div></li>
          <li><span>04</span><div><strong>Set your limits and press Start</strong><p>Choose Practice or Real, set the dollar limits, and pause new trades whenever you want.</p></div></li>
        </ol>
      </section>

      <section className="match-checkout">
        <div>
          <p className="eyebrow">{available ? "Founding price" : "Your choice is still open"}</p>
          <h2>{available ? "$98 once, when checkout opens." : `${result.agent} is not released yet.`}</h2>
          <p>{available
            ? "Checkout is closed while final live testing and the installers are finished. Your quiz answers will not block you."
            : `You can wait for ${result.agent} or choose any bot that has been released. This suggestion never locks you in.`}</p>
          <a className="text-link dark-link" href="/#bots">Compare all bots <span aria-hidden="true">→</span></a>
        </div>
        <button className="button button-disabled" type="button" disabled>Checkout opens after final testing</button>
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
  const allConfirmed = confirmations.losses && confirmations.disclosure && confirmations.choice;
  const canContinue = isConfirmationStep ? allConfirmed : Boolean(selected);

  useEffect(() => {
    document.title = showResult
      ? "Your bot suggestion — DayTradingBot"
      : "Help me choose a bot — DayTradingBot";
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
          <p className="eyebrow">Help me choose</p>
          <h2>A few quick questions. Then you choose.</h2>
          <ul>
            <li>About two minutes</li>
            <li>One question at a time</li>
            <li>Nothing you answer locks you out</li>
            <li>No Social Security number</li>
            <li>No account password or deposit</li>
          </ul>
          <p>We will suggest a bot and starting setup. Your answers stay in this browser during pre-launch testing.</p>
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
                  <h1>Read this before you see your suggestion.</h1>
                  <p className="question-help">These boxes confirm that you saw the fine print. They do not decide which tools you can use.</p>
                  <div className="confirmation-list">
                    <label>
                      <input type="checkbox" checked={confirmations.losses} onChange={(event) => setConfirmations((current) => ({ ...current, losses: event.target.checked }))} />
                      <span><strong>I understand real trading can lose money.</strong><small>AI and Practice results do not guarantee a profit.</small></span>
                    </label>
                    <label>
                      <input type="checkbox" checked={confirmations.disclosure} onChange={(event) => setConfirmations((current) => ({ ...current, disclosure: event.target.checked }))} />
                      <span><strong>I read the <a href="/risk-disclosure/" target="_blank" rel="noreferrer">risk disclosure</a>.</strong><small>It explains trading losses, account responsibility, and what can go wrong with automation.</small></span>
                    </label>
                    <label>
                      <input type="checkbox" checked={confirmations.choice} onChange={(event) => setConfirmations((current) => ({ ...current, choice: event.target.checked }))} />
                      <span><strong>I understand this quiz only makes a suggestion.</strong><small>I can choose any released bot, and I remain responsible for my account and trades.</small></span>
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
              {isConfirmationStep ? "See my suggestion" : "Continue"}
            </button>
          </div>
        </section>
      </div>
    </main>
  );
}
