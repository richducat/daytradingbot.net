import {
  IconAlertTriangle,
  IconArrowDown,
  IconChartCandle,
  IconCheck,
  IconClock,
  IconMessageCircleQuestion,
  IconRobot,
  IconScan,
  IconSend,
  IconShieldCheck,
  IconSparkles,
  IconWallet,
} from "@tabler/icons-react";
import {
  type FormEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  answerTradingRoomQuestion,
  buildTradingRoomMessages,
  type TradingRoomActivity,
  type TradingRoomStageId,
  tradingRoomStages,
  tradingRoomSymbols,
} from "./tradingRoomModel";

type DataLifecycle = "loading" | "ready" | "unavailable";
type TradingRoomStatus = "unavailable" | "paused" | "practice" | "real";

type TradingRoomProps = {
  activity: TradingRoomActivity[];
  activityState: DataLifecycle;
  status: TradingRoomStatus;
  nextCheckLabel: string;
  dailyLimitLabel: string;
  perTradeLimitLabel: string;
  remainingLimitLabel?: string | null;
  onRetry: () => void;
  onOpenWatch: (symbol?: string) => void;
};

type RoomExchange = {
  id: string;
  kind: "customer" | "agent";
  speaker: string;
  stage: TradingRoomStageId | "customer";
  message: string;
  occurredAt: string;
};

function stageIcon(stage: TradingRoomStageId) {
  if (stage === "market") return <IconScan aria-hidden="true" />;
  if (stage === "limits") return <IconShieldCheck aria-hidden="true" />;
  if (stage === "account") return <IconWallet aria-hidden="true" />;
  return <IconRobot aria-hidden="true" />;
}

function stageStatus(
  stage: TradingRoomStageId,
  status: TradingRoomStatus,
  nextCheckLabel: string,
) {
  if (status === "unavailable") return "Status unavailable";
  if (status === "paused") return stage === "account" ? "No new orders" : "Ready when you start";
  if (stage === "market") return nextCheckLabel;
  if (stage === "decision") return "Explaining every decision";
  if (stage === "limits") return status === "practice" ? "Practice limits are on" : "Real limits are on";
  return status === "practice" ? "No orders are sent" : "Reporting Robinhood updates";
}

function roomTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return "Time unavailable";
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function money(value: string | null) {
  if (value === null) return null;
  const amount = Number(value);
  if (!Number.isFinite(amount)) return null;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  }).format(amount);
}

function channelName(channel: string) {
  if (channel === "all") return "Live room";
  if (channel.startsWith("stage:")) {
    return tradingRoomStages.find((stage) => stage.id === channel.slice("stage:".length))?.name
      ?? "Trading room";
  }
  return `${channel.slice("symbol:".length)} room`;
}

export function TradingRoom({
  activity,
  activityState,
  status,
  nextCheckLabel,
  dailyLimitLabel,
  perTradeLimitLabel,
  remainingLimitLabel,
  onRetry,
  onOpenWatch,
}: TradingRoomProps) {
  const [channel, setChannel] = useState("all");
  const [question, setQuestion] = useState("");
  const [exchanges, setExchanges] = useState<RoomExchange[]>([]);
  const [followLive, setFollowLive] = useState(true);
  const feed = useRef<HTMLDivElement>(null);
  const feedEnd = useRef<HTMLDivElement>(null);
  const symbols = useMemo(() => tradingRoomSymbols(activity), [activity]);
  const messages = useMemo(
    () => buildTradingRoomMessages(activity, channel, "oldest"),
    [activity, channel],
  );
  const isRunning = status === "practice" || status === "real";
  const latest = messages[messages.length - 1];
  const latestAgentAnswer = exchanges
    .slice()
    .reverse()
    .find((exchange) => exchange.kind === "agent");
  const followLabel = activityState === "loading"
    ? "Loading updates"
    : activityState === "unavailable" || status === "unavailable"
      ? "Updates unavailable"
      : followLive && isRunning
        ? "Following live"
        : followLive
          ? "At latest update"
          : "Reading earlier updates";
  const isFollowingLive = activityState === "ready" && isRunning && followLive;

  useEffect(() => {
    if (!followLive) return;
    feedEnd.current?.scrollIntoView?.({ block: "end", behavior: "smooth" });
  }, [exchanges.length, followLive, messages.length]);

  const jumpToLatest = () => {
    setFollowLive(true);
    feedEnd.current?.scrollIntoView?.({ block: "end", behavior: "smooth" });
  };

  const ask = (event: FormEvent) => {
    event.preventDefault();
    const customerQuestion = question.trim();
    if (!customerQuestion) return;
    const occurredAt = new Date().toISOString();
    const answer = answerTradingRoomQuestion({
      question: customerQuestion,
      activity,
      status,
      nextCheckLabel,
      dailyLimitLabel,
      perTradeLimitLabel,
      remainingLimitLabel,
    });
    setExchanges((current) => [
      ...current,
      {
        id: `customer-${crypto.randomUUID()}`,
        kind: "customer",
        speaker: "You",
        stage: "customer",
        message: customerQuestion,
        occurredAt,
      },
      {
        id: `agent-${crypto.randomUUID()}`,
        kind: "agent",
        speaker: answer.speaker,
        stage: answer.stage,
        message: answer.message,
        occurredAt,
      },
    ]);
    setQuestion("");
    setFollowLive(true);
  };

  const askQuickQuestion = (value: string) => {
    setQuestion(value);
  };

  return (
    <div className="trading-room">
      <section className="room-team" aria-labelledby="room-team-title">
        <header>
          <div>
            <p className="eyebrow">Your live trading team</p>
            <h2 id="room-team-title">Watch Bluechip work, one handoff at a time</h2>
            <p>Each person below represents a real part of Bluechip’s workflow. The room shows recorded work only—it never invents a trade.</p>
          </div>
          <span className={`room-presence ${status}`}>
            <span aria-hidden="true" />
            {status === "unavailable"
              ? "Status unavailable"
              : isRunning
                ? status === "practice" ? "Practice is live" : "Real Trading is live"
                : "Team is ready"}
          </span>
        </header>
        <div className="room-team-grid" role="list" aria-label="Bluechip trading team">
          {tradingRoomStages.map((stage) => (
            <article className="room-team-member" key={stage.id} role="listitem">
              <span className={`room-avatar ${stage.id}`}>{stageIcon(stage.id)}</span>
              <div>
                <strong>{stage.name}</strong>
                <span>{stage.role}</span>
                <p>{stage.job}</p>
                <small>{stageStatus(stage.id, status, nextCheckLabel)}</small>
              </div>
            </article>
          ))}
        </div>
      </section>

      <section className="room-workspace" aria-labelledby="room-thread-title">
        <aside className="room-channels" aria-label="Trading Room channels">
          <div>
            <p className="eyebrow">Rooms</p>
            <strong>Follow the work</strong>
          </div>
          <button
            className={channel === "all" ? "active" : ""}
            type="button"
            aria-pressed={channel === "all"}
            onClick={() => setChannel("all")}
          >
            <span>#</span>
            Live room
            <small>{activity.length}</small>
          </button>
          {tradingRoomStages.map((stage) => {
            const stageChannel = `stage:${stage.id}`;
            const count = activity.filter((item) => (
              buildTradingRoomMessages([item], stageChannel).length > 0
            )).length;
            return (
              <button
                className={channel === stageChannel ? "active" : ""}
                type="button"
                key={stage.id}
                aria-pressed={channel === stageChannel}
                onClick={() => setChannel(stageChannel)}
              >
                <span className={`room-channel-avatar ${stage.id}`}>{stageIcon(stage.id)}</span>
                {stage.name}
                <small>{count}</small>
              </button>
            );
          })}
          {symbols.length ? <p className="room-channel-heading">Stock rooms</p> : null}
          {symbols.map((symbol) => {
            const count = activity.filter((item) => item.symbol === symbol).length;
            const symbolChannel = `symbol:${symbol}`;
            return (
              <button
                className={channel === symbolChannel ? "active" : ""}
                type="button"
                key={symbol}
                aria-pressed={channel === symbolChannel}
                onClick={() => setChannel(symbolChannel)}
              >
                <span>#</span>
                {symbol}
                <small>{count}</small>
              </button>
            );
          })}
          <p className="room-channel-note">
            <IconShieldCheck aria-hidden="true" />
            Practice and Real Trading always stay labeled.
          </p>
        </aside>

        <div className="room-thread">
          <header>
            <div>
              <p className="eyebrow">{channelName(channel)}</p>
              <h2 id="room-thread-title">
                {channel === "all" ? "What the team is doing" : `Updates from ${channelName(channel)}`}
              </h2>
            </div>
            <div className="room-thread-actions">
              <span className={isFollowingLive ? "following" : ""}>
                <span aria-hidden="true" />
                {followLabel}
              </span>
              <button type="button" onClick={() => onOpenWatch(channel.startsWith("symbol:") ? channel.slice("symbol:".length) : undefined)}>
                <IconChartCandle aria-hidden="true" />
                Open chart
              </button>
            </div>
          </header>

          {activityState === "loading" ? (
            <div className="room-empty" role="status">
              <IconClock aria-hidden="true" />
              <strong>Loading the team’s recorded work…</strong>
            </div>
          ) : null}

          {activityState === "unavailable" ? (
            <div className="room-empty attention" role="alert">
              <IconAlertTriangle aria-hidden="true" />
              <strong>The Trading Room could not load its records</strong>
              <p>This does not mean there was no activity. Nothing was changed.</p>
              <button type="button" onClick={onRetry}>Try the room again</button>
            </div>
          ) : null}

          {activityState === "ready" ? (
            <div className="room-feed-shell">
              <div
                className="room-messages"
                role="log"
                aria-label="Recorded Bluechip conversation"
                aria-live="off"
                ref={feed}
                onScroll={(event) => {
                  const target = event.currentTarget;
                  const nearBottom = target.scrollHeight - target.scrollTop - target.clientHeight < 80;
                  setFollowLive(nearBottom);
                }}
              >
                {!messages.length ? (
                  <div className="room-empty room-empty-compact">
                    <IconSparkles aria-hidden="true" />
                    <strong>{channel === "all" ? "The team is ready for its first check" : `No updates in ${channelName(channel)} yet`}</strong>
                    <p>
                      {channel === "all"
                        ? "Start Practice to watch the whole conversation without sending a real order."
                        : "Choose Live room to see all recorded work."}
                    </p>
                  </div>
                ) : null}

                {messages.map((message, index) => (
                  <article
                    className={`room-message ${message.tone} ${index === messages.length - 1 ? "latest" : ""}`}
                    key={message.id}
                    aria-label={`${message.speaker} at ${roomTime(message.occurred_at)}`}
                  >
                    <span className={`room-avatar ${message.stage}`}>{stageIcon(message.stage)}</span>
                    <div className="room-message-body">
                      <header>
                        <strong>{message.speaker}</strong>
                        <span className="room-speaker-role">{message.speakerRole}</span>
                        <time dateTime={message.occurred_at}>{roomTime(message.occurred_at)}</time>
                        <span className={`room-mode ${message.mode}`}>
                          {message.mode === "practice" ? "Practice" : "Real"}
                        </span>
                      </header>
                      <h3>{message.title}</h3>
                      <p>{message.message}</p>
                      <footer>
                        {message.symbol ? (
                          <button type="button" onClick={() => onOpenWatch(message.symbol ?? undefined)}>
                            <IconChartCandle aria-hidden="true" />
                            {message.symbol}
                          </button>
                        ) : null}
                        {money(message.amount_usd) ? <span>{money(message.amount_usd)}</span> : null}
                        <span className={`room-result ${message.tone}`}>
                          {message.tone === "attention"
                            ? <IconAlertTriangle aria-hidden="true" />
                            : message.tone === "working"
                              ? <IconClock aria-hidden="true" />
                              : <IconCheck aria-hidden="true" />}
                          {message.tone === "attention"
                            ? "Needs attention"
                            : message.tone === "working"
                              ? "Working"
                              : message.tone === "waiting"
                                ? "Recorded"
                                : "Complete"}
                        </span>
                      </footer>
                    </div>
                  </article>
                ))}

                {exchanges.map((exchange) => (
                  <article
                    className={`room-message room-question ${exchange.kind}`}
                    key={exchange.id}
                    aria-label={`${exchange.speaker} at ${roomTime(exchange.occurredAt)}`}
                  >
                    <span className={`room-avatar ${exchange.stage}`}>
                      {exchange.kind === "customer"
                        ? <IconMessageCircleQuestion aria-hidden="true" />
                        : stageIcon(exchange.stage as TradingRoomStageId)}
                    </span>
                    <div className="room-message-body">
                      <header>
                        <strong>{exchange.speaker}</strong>
                        <time dateTime={exchange.occurredAt}>{roomTime(exchange.occurredAt)}</time>
                      </header>
                      <p>{exchange.message}</p>
                    </div>
                  </article>
                ))}
                <div ref={feedEnd} />
              </div>

              {!followLive ? (
                <button className="room-jump-latest" type="button" onClick={jumpToLatest}>
                  <IconArrowDown aria-hidden="true" />
                  Jump to latest
                </button>
              ) : null}

              <form className="room-composer" onSubmit={ask}>
                <label htmlFor="room-question">Ask Bluechip about the recorded work</label>
                <div>
                  <input
                    id="room-question"
                    value={question}
                    onChange={(event) => setQuestion(event.target.value)}
                    placeholder="Why did you skip NVDA?"
                    autoComplete="off"
                  />
                  <button type="submit" disabled={!question.trim()} aria-label="Ask Bluechip">
                    <IconSend aria-hidden="true" />
                  </button>
                </div>
                <div className="room-quick-questions" aria-label="Suggested questions">
                  {["What are you watching?", "How much can be traded?", "When is the next check?"].map((value) => (
                    <button type="button" key={value} onClick={() => askQuickQuestion(value)}>{value}</button>
                  ))}
                </div>
                <small>Questions explain recorded activity. They cannot start, stop, or authorize trading.</small>
              </form>
              <p className="visually-hidden" aria-live="polite" aria-atomic="true">
                {latestAgentAnswer
                  ? `${latestAgentAnswer.speaker} answered: ${latestAgentAnswer.message}`
                  : ""}
              </p>
            </div>
          ) : null}
        </div>

        <aside className="room-live-panel" aria-label="Live trading room summary">
          <div className={`room-live-card ${status}`}>
            <p className="eyebrow">Live now</p>
            <strong>{status === "unavailable"
              ? "Status unavailable"
              : status === "paused"
                ? "Waiting for you"
                : status === "practice"
                  ? "Practice is running"
                  : "Real Trading is running"}</strong>
            <span>{isRunning ? nextCheckLabel : "Choose how you want to start."}</span>
          </div>

          <dl className="room-live-facts">
            <div><dt>Per trade</dt><dd>{perTradeLimitLabel}</dd></div>
            <div><dt>Daily ceiling</dt><dd>{dailyLimitLabel}</dd></div>
            {remainingLimitLabel ? <div><dt>Remaining today</dt><dd>{remainingLimitLabel}</dd></div> : null}
            <div><dt>Latest voice</dt><dd>{latest?.speaker ?? "No update yet"}</dd></div>
          </dl>

          <div className="room-live-roles">
            <p className="eyebrow">Who does what</p>
            {tradingRoomStages.map((stage) => (
              <div key={stage.id}>
                <span className={`room-channel-avatar ${stage.id}`}>{stageIcon(stage.id)}</span>
                <p><strong>{stage.name}</strong><small>{stage.role}</small></p>
              </div>
            ))}
          </div>

          <div className="room-trust-note">
            <IconShieldCheck aria-hidden="true" />
            <p><strong>You stay in control.</strong> The room can explain what happened. Only the separate trading controls can start Practice or review Real Trading.</p>
          </div>
        </aside>
      </section>
    </div>
  );
}
