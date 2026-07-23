// @vitest-environment jsdom

import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}));

import { App } from "./App";

type CommandHandler = () => unknown | Promise<unknown>;

const readOnlyCommands = new Set([
  "trading_agent_catalog",
  "owner_engine_status",
  "recent_trading_activity",
  "bluechip_watch_state",
  "entry_license_status",
  "robinhood_owner_demo_status",
  "coinbase_owner_demo_status",
  "kalshi_owner_demo_status",
  "polymarket_us_owner_demo_status",
]);

const bluechipCatalog = {
  version: 1,
  agents: [
    {
      id: "bluechip",
      name: "Bluechip",
      account: "Robinhood",
      market: "Stocks and ETFs",
      summary: "Reviews a fixed watchlist on a measured cadence.",
      cadence_minutes: 15,
      risk_level: "steady",
      practice_available: true,
      real_trading_available: true,
      customer_ready: true,
      auto_pick_rank: 1,
      engine: {
        kind: "native",
        legacy_label: "local",
        entrypoint: "bluechip",
      },
    },
  ],
};

const pausedEngine = {
  available: true,
  mode: "paused",
  selected_agent_ids: ["bluechip"],
  loaded_agent_ids: ["bluechip"],
  message: "Bluechip is paused.",
};

const pausedWatch = {
  running: false,
  mode: "paused",
  message: "Bluechip is paused.",
  last_checked_at: "2026-07-23T15:00:00Z",
  next_check_at: null,
  budget_state: "paused",
  daily_limit_usd: "15.00",
  per_trade_limit_usd: "3.00",
  used_or_held_usd: null,
  pending_usd: null,
  committed_usd: null,
  remaining_usd: null,
  has_unresolved_real_order: false,
};

const inactiveLicense = {
  activated: false,
  real_trading_ready: false,
  renewal_needed: false,
  expires_at: null,
  message: "Practice is available.",
};

const disconnectedRobinhood = {
  owner_import_available: false,
  configured: false,
  authenticated: false,
  agentic_account_available: false,
  has_buying_power: false,
  connection_state: "not_configured",
};

const connectedUnfundedRobinhood = {
  ...disconnectedRobinhood,
  configured: true,
  authenticated: true,
  agentic_account_available: true,
  connection_state: "connected",
};

const connectedFundedRobinhood = {
  ...connectedUnfundedRobinhood,
  has_buying_power: true,
};

const activeLicense = {
  ...inactiveLicense,
  activated: true,
  real_trading_ready: true,
  message: "App activation is current.",
};

const disconnectedCoinbase = {
  configured: false,
  authenticated: false,
  least_privilege_live_scope: false,
  has_btc_or_eth_account: false,
  connection_state: "not_configured",
};

const disconnectedKalshi = {
  owner_import_available: false,
  configured: false,
  authenticated: false,
  wallet_configured: false,
  direct_api_configured: false,
  has_spendable_balance: false,
  connection_state: "not_configured",
};

const disconnectedPolymarket = {
  configured: false,
  authenticated: false,
  approved_account_verified: false,
  has_buying_power: false,
  market_data_available: true,
  connection_state: "public_data_ready",
};

let commandHandlers: Map<string, CommandHandler>;
let allowedCommands: Set<string>;

function defaultCommandHandlers() {
  return new Map<string, CommandHandler>([
    ["trading_agent_catalog", () => bluechipCatalog],
    ["owner_engine_status", () => pausedEngine],
    ["recent_trading_activity", () => []],
    ["bluechip_watch_state", () => pausedWatch],
    ["entry_license_status", () => inactiveLicense],
    ["robinhood_owner_demo_status", () => disconnectedRobinhood],
    ["coinbase_owner_demo_status", () => disconnectedCoinbase],
    ["kalshi_owner_demo_status", () => disconnectedKalshi],
    ["polymarket_us_owner_demo_status", () => disconnectedPolymarket],
  ]);
}

function rejectWith(message: string): CommandHandler {
  return () => {
    throw new Error(message);
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function allowMockCommand(command: string, handler: CommandHandler) {
  allowedCommands.add(command);
  commandHandlers.set(command, handler);
}

function commandCallCount(command: string) {
  return invokeMock.mock.calls.filter(([calledCommand]) => calledCommand === command).length;
}

function isDisabled(element: HTMLElement) {
  if (!(element instanceof HTMLButtonElement)) {
    throw new Error("Expected an HTML button");
  }
  return element.disabled;
}

async function openSetupAtModeStep(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole("button", { name: "Setup" }));
  const dialog = await screen.findByRole("dialog", { name: "Connect your accounts" });
  await user.click(within(dialog).getByRole("button", { name: "Continue" }));
  await within(dialog).findByText("Choose your trading agent");
  await within(dialog).findByLabelText("Selected");
  await user.click(within(dialog).getByRole("button", { name: "Continue" }));
  await within(dialog).findByText("Set your limits");
  await user.click(within(dialog).getByRole("button", { name: "Continue" }));
  await within(dialog).findByText("Choose how to start");
  return dialog;
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem("dtb.setupComplete", "yes");
  localStorage.setItem("dtb.selectedAgents", JSON.stringify(["bluechip"]));
  localStorage.setItem("dtb.dailyBudget", "15");
  localStorage.setItem("dtb.perTrade", "3");
  localStorage.setItem("dtb.mode", "practice");

  vi.stubGlobal(
    "requestAnimationFrame",
    (callback: FrameRequestCallback) => window.setTimeout(() => callback(performance.now()), 0),
  );
  vi.stubGlobal(
    "cancelAnimationFrame",
    (handle: number) => window.clearTimeout(handle),
  );

  commandHandlers = defaultCommandHandlers();
  allowedCommands = new Set(readOnlyCommands);
  invokeMock.mockReset();
  invokeMock.mockImplementation((command: string) => {
    if (!allowedCommands.has(command)) {
      return Promise.reject(new Error(`COMMAND_NOT_ALLOWLISTED:${command}`));
    }
    const handler = commandHandlers.get(command);
    if (!handler) return Promise.reject(new Error(`UNEXPECTED_COMMAND:${command}`));
    try {
      return Promise.resolve(handler());
    } catch (error) {
      return Promise.reject(error);
    }
  });
});

afterEach(() => {
  cleanup();
  const observedCommands = invokeMock.mock.calls.map(([command]) => String(command));
  expect(observedCommands.filter((command) => !allowedCommands.has(command))).toEqual([]);
  vi.unstubAllGlobals();
});

describe("rendered fail-closed readbacks", () => {
  it("offers only a read-only status check when the watch state is unknown", async () => {
    commandHandlers.set(
      "bluechip_watch_state",
      rejectWith("WATCH_STATUS_UNAVAILABLE"),
    );
    const user = userEvent.setup();

    render(<App />);

    await screen.findByText(/couldn’t confirm Bluechip or your remaining daily amount/i);
    const checkAgain = await screen.findByRole("button", { name: "Check again" });
    expect(isDisabled(checkAgain)).toBe(false);

    for (const actionName of ["Start Practice", "Review Real Trading"]) {
      const action = screen.queryByRole("button", { name: actionName });
      expect(action === null || isDisabled(action)).toBe(true);
    }

    const watchChecksBeforeRetry = commandCallCount("bluechip_watch_state");
    await user.click(checkAgain);

    await screen.findByText(/still couldn’t confirm Bluechip’s status/i);
    expect(commandCallCount("bluechip_watch_state")).toBeGreaterThan(watchChecksBeforeRetry);
    expect(commandCallCount("start_owner_engine_session")).toBe(0);
    expect(commandCallCount("pause_owner_engine_session")).toBe(0);
  });

  it("shows activity as unavailable instead of claiming there are no outcomes", async () => {
    commandHandlers.set(
      "recent_trading_activity",
      rejectWith("ACTIVITY_READBACK_UNAVAILABLE"),
    );
    const user = userEvent.setup();

    render(<App />);

    await screen.findByText("Recorded activity is unavailable");
    expect(screen.queryByText("No recorded outcomes yet")).toBeNull();
    expect(screen.queryByRole("button", { name: "Try activity again" })).not.toBeNull();

    await user.click(screen.getByRole("button", { name: "History" }));
    await screen.findByRole("heading", { name: "Practice and Real stay separate" });

    expect(screen.queryByText(/^No (Practice |Real )?records yet$/)).toBeNull();
    expect(screen.queryByText("Recorded activity is unavailable")).not.toBeNull();
  });

  it("renders a failed catalog readback and recovers through its read-only retry", async () => {
    let catalogAttempts = 0;
    commandHandlers.set("trading_agent_catalog", () => {
      catalogAttempts += 1;
      if (catalogAttempts === 1) throw new Error("CATALOG_READBACK_UNAVAILABLE");
      return bluechipCatalog;
    });
    const user = userEvent.setup();

    render(<App />);
    await user.click(screen.getByRole("button", { name: "Agents" }));

    await screen.findByText("Agent catalog is unavailable");
    const retry = screen.getByRole("button", { name: "Try agent catalog again" });
    expect(isDisabled(retry)).toBe(false);

    await user.click(retry);

    await screen.findByText("Bluechip");
    await waitFor(() => {
      expect(screen.queryByText("Agent catalog is unavailable")).toBeNull();
    });
    expect(catalogAttempts).toBe(2);
  });

  it("presents a failed license readback as unavailable, not unactivated", async () => {
    commandHandlers.set(
      "entry_license_status",
      rejectWith("LICENSE_STATUS_UNAVAILABLE"),
    );
    const user = userEvent.setup();

    render(<App />);

    const unavailable = await screen.findByRole("button", {
      name: "Activation status unavailable",
    });
    expect(isDisabled(unavailable)).toBe(false);
    expect(screen.queryByRole("button", { name: "Activate app" })).toBeNull();

    await user.click(unavailable);

    const dialog = await screen.findByRole("dialog", { name: "Activate DayTradingBot" });
    expect(
      within(dialog).queryByText(/could not confirm whether this copy is activated/i),
    ).not.toBeNull();
    expect(within(dialog).queryByLabelText("Access code")).toBeNull();
    expect(
      within(dialog).queryByRole("button", { name: "Check activation again" }),
    ).not.toBeNull();
  });
});

describe("rendered trading controls", () => {
  it("exposes Practice and Real trading as an aria-pressed mode choice", async () => {
    const user = userEvent.setup();

    render(<App />);

    await screen.findByRole("button", { name: "Start Practice" });
    await user.click(screen.getByRole("button", { name: "Setup" }));

    const dialog = await screen.findByRole("dialog", { name: "Connect your accounts" });
    await user.click(within(dialog).getByRole("button", { name: "Continue" }));
    await waitFor(() => {
      expect(within(dialog).queryByText("Choose your trading agent")).not.toBeNull();
    });
    await within(dialog).findByLabelText("Selected");
    await user.click(within(dialog).getByRole("button", { name: "Continue" }));
    await waitFor(() => {
      expect(within(dialog).queryByText("Set your limits")).not.toBeNull();
    });
    await user.click(within(dialog).getByRole("button", { name: "Continue" }));
    await waitFor(() => {
      expect(within(dialog).queryByText("Choose how to start")).not.toBeNull();
    });

    const practice = within(dialog).getByRole("button", { name: /^Practice\b/ });
    const real = within(dialog).getByRole("button", { name: /^Real trading\b/ });
    expect(practice.getAttribute("aria-pressed")).toBe("true");
    expect(real.getAttribute("aria-pressed")).toBe("false");

    await user.click(real);

    expect(practice.getAttribute("aria-pressed")).toBe("false");
    expect(real.getAttribute("aria-pressed")).toBe("true");
  });

  it("keeps an enabled Real pause action inside the credential workflow", async () => {
    localStorage.setItem("dtb.mode", "real");
    commandHandlers.set("owner_engine_status", () => ({
      ...pausedEngine,
      mode: "real",
      message: "Bluechip is running in Real mode.",
    }));
    commandHandlers.set("bluechip_watch_state", () => ({
      ...pausedWatch,
      running: true,
      mode: "real",
      message: "Bluechip is running in Real mode.",
      next_check_at: "2026-07-23T15:15:00Z",
      budget_state: "available",
      remaining_usd: "12.00",
    }));
    commandHandlers.set("entry_license_status", () => ({
      ...inactiveLicense,
      activated: true,
      real_trading_ready: true,
      message: "App activation is current.",
    }));
    const user = userEvent.setup();

    render(<App />);

    const topbarPause = await screen.findByRole("button", {
      name: "Pause new real trades",
    });
    expect(isDisabled(topbarPause)).toBe(false);

    await user.click(screen.getByRole("button", { name: "Accounts" }));
    const coinbaseLabel = await screen.findByText("Coinbase");
    const coinbaseRow = coinbaseLabel.closest("article");
    expect(coinbaseRow).not.toBeNull();
    const openCredentials = await within(coinbaseRow!).findByRole("button", {
      name: "Add account",
    });

    await user.click(openCredentials);

    const dialog = await screen.findByRole("dialog", { name: "Coinbase" });
    const modalPause = within(dialog).getByRole("button", {
      name: "Pause new real trades",
    });
    expect(isDisabled(modalPause)).toBe(false);
    expect(within(dialog).queryByLabelText("Private key")).not.toBeNull();

    const closeCredentials = within(dialog).getByRole("button", {
      name: "Close account connection",
    });
    await waitFor(() => {
      expect(document.activeElement).toBe(closeCredentials);
    });

    await user.keyboard("{Escape}");

    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Coinbase" })).toBeNull();
    });
    expect(document.activeElement).toBe(openCredentials);
    expect(
      isDisabled(screen.getByRole("button", { name: "Pause new real trades" })),
    ).toBe(false);
  });
});

describe("second-pass safety regressions", () => {
  it.each([
    {
      name: "engine running while watch says paused",
      engine: { ...pausedEngine, mode: "real", message: "Engine reports Real running." },
      watch: pausedWatch,
    },
    {
      name: "watch running while engine says paused",
      engine: pausedEngine,
      watch: {
        ...pausedWatch,
        running: true,
        mode: "practice",
        next_check_at: "2026-07-23T15:15:00Z",
        message: "Watch reports Practice running.",
      },
    },
  ])("shows a fail-closed Pause for $name", async ({ engine, watch }) => {
    commandHandlers.set("owner_engine_status", () => engine);
    commandHandlers.set("bluechip_watch_state", () => watch);

    render(<App />);

    const pause = await screen.findByRole("button", { name: "Pause trading" });
    expect(isDisabled(pause)).toBe(false);
    expect(screen.queryByRole("button", { name: "Start Practice" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Review Real Trading" })).toBeNull();
    expect(screen.queryByText("Bluechip status reports disagree")).not.toBeNull();
    expect(commandCallCount("start_owner_engine_session")).toBe(0);
    expect(commandCallCount("pause_owner_engine_session")).toBe(0);
  });

  it("locks setup dismissal while a mocked Practice start is unresolved", async () => {
    const attempt = deferred<{
      mode: "practice";
      selected_agent_ids: string[];
      message: string;
    }>();
    allowMockCommand("start_owner_engine_session", () => attempt.promise);
    const user = userEvent.setup();

    render(<App />);
    await screen.findByRole("button", { name: "Start Practice" });
    const dialog = await openSetupAtModeStep(user);
    const start = within(dialog).getByRole("button", { name: "Start Practice" });

    await user.click(start);
    await within(dialog).findByText(/Starting Practice… DayTradingBot is waiting/i);

    expect(commandCallCount("start_owner_engine_session")).toBe(1);
    expect(isDisabled(within(dialog).getByRole("button", { name: "Close setup" }))).toBe(true);
    expect(isDisabled(within(dialog).getByRole("button", { name: "Back" }))).toBe(true);
    const pendingStart = within(dialog).getByRole("button", { name: "Starting…" });
    expect(isDisabled(pendingStart)).toBe(true);
    await user.click(pendingStart);
    expect(commandCallCount("start_owner_engine_session")).toBe(1);

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Choose how to start" })).not.toBeNull();
    expect(commandCallCount("start_owner_engine_session")).toBe(1);

    attempt.resolve({
      mode: "practice",
      selected_agent_ids: ["bluechip"],
      message: "Mocked Practice start completed.",
    });
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Choose how to start" })).toBeNull();
    });
  });

  it("locks Real-review dismissal while a mocked Real start is unresolved", async () => {
    localStorage.setItem("dtb.mode", "real");
    commandHandlers.set("entry_license_status", () => activeLicense);
    commandHandlers.set("robinhood_owner_demo_status", () => connectedFundedRobinhood);
    const attempt = deferred<{
      mode: "real";
      selected_agent_ids: string[];
      message: string;
    }>();
    allowMockCommand("start_owner_engine_session", () => attempt.promise);
    const user = userEvent.setup();

    render(<App />);
    const review = await screen.findByRole("button", { name: "Review Real Trading" });
    await user.click(review);
    const dialog = await screen.findByRole("alertdialog", {
      name: "Allow Bluechip to trade on Robinhood?",
    });
    await user.click(within(dialog).getByRole("button", {
      name: "Allow these trades for 24 hours",
    }));
    await within(dialog).findByText(/Starting Real Trading… DayTradingBot is waiting/i);

    expect(commandCallCount("start_owner_engine_session")).toBe(1);
    expect(isDisabled(within(dialog).getByRole("button", { name: "Go back" }))).toBe(true);
    const pendingStart = within(dialog).getByRole("button", { name: "Starting…" });
    expect(isDisabled(pendingStart)).toBe(true);
    await user.click(pendingStart);
    expect(commandCallCount("start_owner_engine_session")).toBe(1);
    expect(invokeMock).toHaveBeenCalledWith("start_owner_engine_session", {
      request: {
        agent_ids: ["bluechip"],
        mode: "real",
        daily_budget_usd: 15,
        max_per_trade_usd: 3,
        real_confirmation: "START REAL TRADING",
      },
    });

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("alertdialog", {
      name: "Allow Bluechip to trade on Robinhood?",
    })).not.toBeNull();
    expect(commandCallCount("start_owner_engine_session")).toBe(1);

    attempt.resolve({
      mode: "real",
      selected_agent_ids: ["bluechip"],
      message: "Mocked Real start completed.",
    });
    await waitFor(() => {
      expect(screen.queryByRole("alertdialog", {
        name: "Allow Bluechip to trade on Robinhood?",
      })).toBeNull();
    });
  });

  it("locks credential dismissal while a mocked secure save is unresolved and keeps Pause reachable", async () => {
    commandHandlers.set("owner_engine_status", () => ({
      ...pausedEngine,
      mode: "practice",
      message: "Practice is running.",
    }));
    commandHandlers.set("bluechip_watch_state", () => ({
      ...pausedWatch,
      running: true,
      mode: "practice",
      next_check_at: "2026-07-23T15:15:00Z",
      message: "Practice is running.",
    }));
    const attempt = deferred<void>();
    allowMockCommand("connect_coinbase_account", () => attempt.promise);
    const user = userEvent.setup();

    render(<App />);
    await screen.findByRole("button", { name: "Pause Practice" });
    await user.click(screen.getByRole("button", { name: "Accounts" }));
    const accountsView = screen.getByRole("heading", {
      name: "Use the accounts you already have",
    }).closest("section");
    const coinbaseRow = within(accountsView!).getByText("Coinbase").closest("article");
    await user.click(within(coinbaseRow!).getByRole("button", { name: "Add account" }));
    const dialog = await screen.findByRole("dialog", { name: "Coinbase" });
    await user.type(within(dialog).getByLabelText("API key name"), "fixture-key");
    await user.type(within(dialog).getByLabelText("Private key"), "fixture-secret");
    await user.click(within(dialog).getByRole("button", { name: "Connect Coinbase" }));
    await within(dialog).findByText(/Checking and securely saving the Coinbase connection/i);

    expect(commandCallCount("connect_coinbase_account")).toBe(1);
    expect(isDisabled(within(dialog).getByRole("button", { name: "Close account connection" }))).toBe(true);
    expect(isDisabled(within(dialog).getByRole("button", { name: "Cancel" }))).toBe(true);
    expect(isDisabled(within(dialog).getByRole("button", { name: "Pause Practice" }))).toBe(false);
    await user.click(within(dialog).getByRole("button", { name: "Saving connection…" }));
    expect(commandCallCount("connect_coinbase_account")).toBe(1);
    expect(invokeMock).toHaveBeenCalledWith("connect_coinbase_account", {
      request: {
        key_name: "fixture-key",
        private_key_pem: "fixture-secret",
      },
    });

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Coinbase" })).not.toBeNull();
    expect(commandCallCount("connect_coinbase_account")).toBe(1);

    attempt.resolve();
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Coinbase" })).toBeNull();
    });
  });

  it("locks activation dismissal while mocked activation is unresolved and keeps Pause reachable", async () => {
    commandHandlers.set("owner_engine_status", () => ({
      ...pausedEngine,
      mode: "practice",
      message: "Practice is running.",
    }));
    commandHandlers.set("bluechip_watch_state", () => ({
      ...pausedWatch,
      running: true,
      mode: "practice",
      next_check_at: "2026-07-23T15:15:00Z",
      message: "Practice is running.",
    }));
    const attempt = deferred<typeof activeLicense>();
    allowMockCommand("activate_license", () => attempt.promise);
    const user = userEvent.setup();

    render(<App />);
    await user.click(await screen.findByRole("button", { name: "Activate app" }));
    const dialog = await screen.findByRole("dialog", { name: "Activate DayTradingBot" });
    await user.type(within(dialog).getByLabelText("Access code"), "dtb-test");
    await user.click(within(dialog).getByRole("button", { name: "Activate app" }));
    await within(dialog).findByText(/Activating DayTradingBot… This window will close/i);

    expect(commandCallCount("activate_license")).toBe(1);
    expect(isDisabled(within(dialog).getByRole("button", { name: "Close activation" }))).toBe(true);
    expect(isDisabled(within(dialog).getByRole("button", { name: "Close" }))).toBe(true);
    expect(isDisabled(within(dialog).getByRole("button", { name: "Pause Practice" }))).toBe(false);
    await user.click(within(dialog).getByRole("button", { name: "Activating…" }));
    expect(commandCallCount("activate_license")).toBe(1);
    expect(invokeMock).toHaveBeenCalledWith("activate_license", {
      request: { license_code: "DTB-TEST" },
    });

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Activate DayTradingBot" })).not.toBeNull();
    expect(commandCallCount("activate_license")).toBe(1);

    attempt.resolve(activeLicense);
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Activate DayTradingBot" })).toBeNull();
    });
  });

  it("never labels connected-unfunded accounts Ready and names the Polymarket API-key action", async () => {
    commandHandlers.set("robinhood_owner_demo_status", () => connectedUnfundedRobinhood);
    const user = userEvent.setup();

    render(<App />);

    const practice = await screen.findByRole("button", { name: "Start Practice" });
    expect(isDisabled(practice)).toBe(false);
    expect(await screen.findByText("Robinhood is connected · funding needed before Real Trading.")).not.toBeNull();

    await user.click(screen.getByRole("button", { name: "Accounts" }));
    const accountsView = screen.getByRole("heading", {
      name: "Use the accounts you already have",
    }).closest("section");
    const robinhoodRow = within(accountsView!).getByText("Robinhood").closest("article");
    expect(within(robinhoodRow!).queryByText("Ready")).toBeNull();
    expect(within(robinhoodRow!).queryByText("Connected · funding needed")).not.toBeNull();
    expect(within(robinhoodRow!).queryByText(/funding needed before Real Trading/i)).not.toBeNull();

    const polymarketRow = within(accountsView!).getByText("Polymarket").closest("article");
    expect(within(polymarketRow!).queryByRole("button", { name: "Add API key" })).not.toBeNull();
    expect(within(polymarketRow!).queryByText(/wallet/i)).toBeNull();

    await user.click(screen.getByRole("button", { name: "Setup" }));
    const setup = await screen.findByRole("dialog", { name: "Connect your accounts" });
    expect(within(setup).queryByText("Connected · funding needed before Real Trading")).not.toBeNull();
    expect(within(setup).queryByRole("button", { name: "Add API key" })).not.toBeNull();
    expect(within(setup).queryByText("Ready")).toBeNull();
  });
});
