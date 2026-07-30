// @vitest-environment jsdom

import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TradingRoom } from "./TradingRoom";
import type { TradingRoomActivity } from "./tradingRoomModel";

const recordedActivity: TradingRoomActivity[] = [
  {
    id: "scan-aapl",
    agent_id: "bluechip",
    mode: "practice",
    kind: "market_check",
    recorded_order_state: null,
    symbol: "AAPL",
    amount_usd: null,
    message: "Bluechip reviewed AAPL.",
    occurred_at: "2026-07-29T10:00:00-04:00",
  },
  {
    id: "signal-qqq",
    agent_id: "bluechip",
    mode: "practice",
    kind: "signal",
    recorded_order_state: null,
    symbol: "QQQ",
    amount_usd: "20.00",
    message: "QQQ matched Bluechip’s rule.",
    occurred_at: "2026-07-29T10:05:00-04:00",
  },
  {
    id: "review-qqq",
    agent_id: "bluechip",
    mode: "practice",
    kind: "reviewed",
    recorded_order_state: "practice_review",
    symbol: "QQQ",
    amount_usd: "20.00",
    message: "Practice recorded a $20 review and sent no real order.",
    occurred_at: "2026-07-29T10:06:00-04:00",
  },
];

afterEach(() => cleanup());

describe("Trading Room interface", () => {
  it("shows the four visible process stages and labels the active mode", () => {
    render(
      <TradingRoom
        activity={recordedActivity}
        activityState="ready"
        status="practice"
        nextCheckLabel="Next check at 10:15 AM"
        dailyLimitLabel="$100"
        perTradeLimitLabel="$20"
        remainingLimitLabel="$80"
        onRetry={vi.fn()}
        onOpenWatch={vi.fn()}
      />,
    );

    const process = screen.getByRole("list", { name: "Bluechip trading team" });
    for (const name of ["Market Scout", "Bluechip", "Limit Guide", "Robinhood"]) {
      expect(within(process).queryByText(name)).not.toBeNull();
    }
    expect(screen.queryByText("Practice is live")).not.toBeNull();
    expect(screen.queryByText("Working now")).toBeNull();
  });

  it("shows recorded messages in time order and keeps Practice visibly labeled", () => {
    render(
      <TradingRoom
        activity={recordedActivity}
        activityState="ready"
        status="practice"
        nextCheckLabel="Next check at 10:15 AM"
        dailyLimitLabel="$100"
        perTradeLimitLabel="$20"
        remainingLimitLabel="$80"
        onRetry={vi.fn()}
        onOpenWatch={vi.fn()}
      />,
    );

    const feed = screen.getByRole("log", { name: "Recorded Bluechip conversation" });
    expect(within(feed).queryByText("QQQ matched Bluechip’s rule.")).not.toBeNull();
    expect(within(feed).queryByText("Practice recorded a $20 review and sent no real order.")).not.toBeNull();
    expect(within(feed).getAllByText("Practice")).toHaveLength(3);
    const entries = within(feed).getAllByRole("article");
    expect(entries[0]?.getAttribute("aria-label")).toMatch(/^Market Scout at /);
    expect(entries[2]?.getAttribute("aria-label")).toMatch(/^Limit Guide at /);
  });

  it("filters a symbol room and opens its chart", async () => {
    const user = userEvent.setup();
    const onOpenWatch = vi.fn();
    render(
      <TradingRoom
        activity={recordedActivity}
        activityState="ready"
        status="paused"
        nextCheckLabel="Waiting for the next check"
        dailyLimitLabel="$100"
        perTradeLimitLabel="$20"
        onRetry={vi.fn()}
        onOpenWatch={onOpenWatch}
      />,
    );

    await user.click(screen.getByRole("button", { name: /QQQ 2/ }));
    expect(screen.queryByRole("heading", { name: "Updates from QQQ room" })).not.toBeNull();
    expect(screen.queryByText("Bluechip reviewed AAPL.")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Open chart" }));
    expect(onOpenWatch).toHaveBeenCalledWith("QQQ");
  });

  it("answers questions from recorded state without exposing a trading action", async () => {
    const user = userEvent.setup();
    render(
      <TradingRoom
        activity={recordedActivity}
        activityState="ready"
        status="practice"
        nextCheckLabel="Next check at 10:15 AM"
        dailyLimitLabel="$100"
        perTradeLimitLabel="$20"
        remainingLimitLabel="$80"
        onRetry={vi.fn()}
        onOpenWatch={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "How much can be traded?" }));
    await user.click(screen.getByRole("button", { name: "Ask Bluechip" }));

    const feed = screen.getByRole("log", { name: "Recorded Bluechip conversation" });
    expect(within(feed).queryByText("How much can be traded?")).not.toBeNull();
    expect(within(feed).queryByText(
      "Your current ceiling is $20 for one trade and $100 in new trades for the day. The app currently reports $80 remaining for new trades today.",
    )).not.toBeNull();
    expect(screen.queryByText(/cannot start, stop, or authorize trading/i)).not.toBeNull();
    expect(screen.queryByRole("button", { name: /start trading/i })).toBeNull();
  });

  it("fails closed when records cannot be loaded", async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    render(
      <TradingRoom
        activity={[]}
        activityState="unavailable"
        status="unavailable"
        nextCheckLabel="Waiting for the next check"
        dailyLimitLabel="$100"
        perTradeLimitLabel="$20"
        onRetry={onRetry}
        onOpenWatch={vi.fn()}
      />,
    );

    expect(screen.queryByRole("alert")).not.toBeNull();
    expect(screen.queryByText(/does not mean there was no activity/i)).not.toBeNull();
    expect(screen.queryByText("Updates unavailable")).not.toBeNull();
    expect(screen.queryByText("Following live")).toBeNull();
    expect(screen.queryByText(/first check/i)).toBeNull();
    await user.click(screen.getByRole("button", { name: "Try the room again" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("announces a new explanation without making the recorded ledger live", async () => {
    const user = userEvent.setup();
    render(
      <TradingRoom
        activity={recordedActivity}
        activityState="ready"
        status="practice"
        nextCheckLabel="Next check at 10:15 AM"
        dailyLimitLabel="$100"
        perTradeLimitLabel="$20"
        remainingLimitLabel="$80"
        onRetry={vi.fn()}
        onOpenWatch={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "How much can be traded?" }));
    await user.click(screen.getByRole("button", { name: "Ask Bluechip" }));

    const liveRegion = document.querySelector('[aria-live="polite"]');
    expect(liveRegion?.textContent).toContain(
      "Limit Guide answered: Your current ceiling is $20 for one trade",
    );
    expect(screen.getByRole("log", { name: "Recorded Bluechip conversation" })
      .getAttribute("aria-live")).toBe("off");
  });
});
