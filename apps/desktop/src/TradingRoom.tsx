import {
  IconAlertTriangle,
  IconChartCandle,
  IconCheck,
  IconClock,
  IconRobot,
  IconScan,
  IconShieldCheck,
  IconSparkles,
  IconWallet,
} from "@tabler/icons-react";
import { useMemo, useState } from "react";
import {
  buildTradingRoomMessages,
  type TradingRoomActivity,
  type TradingRoomStageId,
  tradingRoomSymbols,
  tradingRoomStages,
} from "./tradingRoomModel";

type DataLifecycle = "loading" | "ready" | "unavailable";
type TradingRoomStatus = "unavailable" | "paused" | "practice" | "real";

type TradingRoomProps = {
  activity: TradingRoomActivity[];
  activityState: DataLifecycle;
  status: TradingRoomStatus;
  nextCheckLabel: string;
  onRetry: () => void;
  onOpenWatch: (symbol?: string) => void;
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
  if (stage === "decision") return "Every decision is recorded";
  if (stage === "limits") return status === "practice" ? "Practice limits are on" : "Real limits are on";
  return status === "practice" ? "No orders are sent" : "Shows Robinhood updates";
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

export function TradingRoom({
  activity,
  activityState,
  status,
  nextCheckLabel,
  onRetry,
  onOpenWatch,
}: TradingRoomProps) {
  const [channel, setChannel] = useState<"all" | string>("all");
  const symbols = useMemo(() => tradingRoomSymbols(activity), [activity]);
  const messages = useMemo(
    () => buildTradingRoomMessages(activity, channel),
    [activity, channel],
  );
  const isRunning = status === "practice" || status === "real";

  return (
    <div className="trading-room">
      <section className="room-team" aria-labelledby="room-team-title">
        <header>
          <div>
            <p className="eyebrow">How Bluechip works</p>
            <h2 id="room-team-title">See every recorded step</h2>
            <p>The cards explain the process. The messages below come only from recorded app activity.</p>
          </div>
          <span className={`room-presence ${status}`}>
            <span aria-hidden="true" />
            {status === "unavailable"
              ? "Status unavailable"
              : isRunning
                ? status === "practice" ? "Practice is running" : "Real trading is running"
                : "Bluechip is ready"}
          </span>
        </header>
        <div className="room-team-grid" role="list" aria-label="Bluechip trading process">
          {tradingRoomStages.map((stage) => (
            <article className="room-team-member" key={stage.id} role="listitem">
              <span className={`room-avatar ${stage.id}`}>{stageIcon(stage.id)}</span>
              <div>
                <strong>{stage.name}</strong>
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
            <strong>Recorded activity</strong>
          </div>
          <button
            className={channel === "all" ? "active" : ""}
            type="button"
            aria-pressed={channel === "all"}
            onClick={() => setChannel("all")}
          >
            <span>#</span>
            All activity
            <small>{activity.length}</small>
          </button>
          {symbols.map((symbol) => {
            const count = activity.filter((item) => item.symbol === symbol).length;
            return (
              <button
                className={channel === symbol ? "active" : ""}
                type="button"
                key={symbol}
                aria-pressed={channel === symbol}
                onClick={() => setChannel(symbol)}
              >
                <span>#</span>
                {symbol}
                <small>{count}</small>
              </button>
            );
          })}
          <p className="room-channel-note">
            <IconShieldCheck aria-hidden="true" />
            Practice and Real records always stay labeled.
          </p>
        </aside>

        <div className="room-thread">
          <header>
            <div>
              <p className="eyebrow">{channel === "all" ? "Today’s room" : `${channel} room`}</p>
              <h2 id="room-thread-title">
                {channel === "all" ? "What Bluechip recorded" : `What happened with ${channel}`}
              </h2>
            </div>
            <div className="room-thread-actions">
              <span>Latest first</span>
              <button type="button" onClick={() => onOpenWatch(channel === "all" ? undefined : channel)}>
                <IconChartCandle aria-hidden="true" />
                Open chart
              </button>
            </div>
          </header>

          {activityState === "loading" ? (
            <div className="room-empty" role="status">
              <IconClock aria-hidden="true" />
              <strong>Loading Bluechip’s recorded work…</strong>
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

          {activityState === "ready" && !messages.length ? (
            <div className="room-empty">
              <IconSparkles aria-hidden="true" />
              <strong>{channel === "all" ? "Bluechip is ready for its first check" : `No ${channel} records yet`}</strong>
              <p>
                {channel === "all"
                  ? "Start Practice to watch every handoff without sending a real order."
                  : "Open the chart or return to All activity to see the rest of Bluechip’s records."}
              </p>
              <button type="button" onClick={() => onOpenWatch(channel === "all" ? undefined : channel)}>
                Open Watch
              </button>
            </div>
          ) : null}

          {activityState === "ready" && messages.length ? (
            <div className="room-messages" role="feed" aria-label="Recorded Bluechip activity">
              {messages.map((message) => {
                return (
                  <article
                    className={`room-message ${message.tone}`}
                    key={message.id}
                    aria-label={`Bluechip at ${roomTime(message.occurred_at)}`}
                  >
                    <span className={`room-avatar ${message.stage}`}>{stageIcon(message.stage)}</span>
                    <div className="room-message-body">
                      <header>
                        <strong>Bluechip</strong>
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
                              ? "In progress"
                              : message.tone === "waiting"
                                ? "Recorded"
                                : "Complete"}
                        </span>
                      </footer>
                    </div>
                  </article>
                );
              })}
            </div>
          ) : null}
        </div>
      </section>
    </div>
  );
}
