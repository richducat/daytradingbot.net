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
        onRetry={vi.fn()}
        onOpenWatch={vi.fn()}
      />,
    );

    const process = screen.getByRole("list", { name: "Bluechip trading process" });
    for (const name of ["Market check", "Strategy decision", "Limit Check", "Account update"]) {
      expect(within(process).queryByText(name)).not.toBeNull();
    }
    expect(screen.queryByText("Practice is running")).not.toBeNull();
    expect(screen.queryByText("Working now")).toBeNull();
  });

  it("shows only recorded messages and keeps Practice visibly labeled", () => {
    render(
      <TradingRoom
        activity={recordedActivity}
        activityState="ready"
        status="practice"
        nextCheckLabel="Next check at 10:15 AM"
        onRetry={vi.fn()}
        onOpenWatch={vi.fn()}
      />,
    );

    const feed = screen.getByRole("feed", { name: "Recorded Bluechip activity" });
    expect(within(feed).queryByText("QQQ matched Bluechip’s rule.")).not.toBeNull();
    expect(within(feed).queryByText("Practice recorded a $20 review and sent no real order.")).not.toBeNull();
    expect(within(feed).getAllByText("Practice")).toHaveLength(3);
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
        onRetry={vi.fn()}
        onOpenWatch={onOpenWatch}
      />,
    );

    await user.click(screen.getByRole("button", { name: /QQQ 2/ }));
    expect(screen.queryByRole("heading", { name: "What happened with QQQ" })).not.toBeNull();
    expect(screen.queryByText("Bluechip reviewed AAPL.")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Open chart" }));
    expect(onOpenWatch).toHaveBeenCalledWith("QQQ");
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
        onRetry={onRetry}
        onOpenWatch={vi.fn()}
      />,
    );

    expect(screen.queryByRole("alert")).not.toBeNull();
    expect(screen.queryByText(/does not mean there was no activity/i)).not.toBeNull();
    expect(screen.queryByText(/first check/i)).toBeNull();
    await user.click(screen.getByRole("button", { name: "Try the room again" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});
