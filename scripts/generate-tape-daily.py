#!/usr/bin/env python3
"""The Tape, Daily — static shift-report pages for the Bluechip desk.

Reads the live fund snapshot (from the eb28.co checkout, refreshed every
5 minutes by ai.eb28.fundmanager.publisher) and the Robinhood desk journal,
renders one page per market day to tape/YYYY-MM-DD/index.html plus a /tape/
archive index on daytradingbot.net, in the Bluechip daylight design language.

Fail-closed everywhere:
  - missing/stale snapshot        -> exit 1, nothing written
  - missing journal               -> exit 1, nothing written
  - compliance lint violation     -> exit 1, nothing written
  - no journal data for the day   -> exit 0, day skipped (nothing to report)

Usage:
  generate-tape-daily.py                  # today's page (launchd, ~5:30pm ET)
  generate-tape-daily.py --backfill 30    # build any missing pages, last 30 days
  generate-tape-daily.py --date 2026-07-01
  generate-tape-daily.py ... --no-push    # local run, verify before pushing
  generate-tape-daily.py ... --rebuild    # re-render pages that already exist

Runs via launchd label net.daytradingbot.tape.daily (Mon–Fri 17:30 ET).
"""
import argparse
import json
import sys
from datetime import datetime, date, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from eb28_growth_lib import (  # noqa: E402
    DOCS, ET, GateError, REPO, SITE_ORIGIN, TAPE_MANIFEST_PATH,
    esc, fmt_display_date, fmt_weekday, git_publish, is_market_day,
    lint_or_die, load_journal_days, load_snapshot, page_shell, update_sitemap,
)

TAPE_DIR = DOCS / "tape"
MAX_TAPE_LINES = 60


def day_url(day):
    return f"{SITE_ORIGIN}/tape/{day}/"


def mode_label(day_facts):
    return "Live" if day_facts["live"] else "Review-only (paper)"


def bluechip_lane(snapshot):
    for lane in snapshot.get("lanes") or []:
        if lane.get("id") == "robinhood-equities":
            return lane
    return None


def render_tape_lines(day_facts):
    reviews = day_facts["reviews"]
    lines = []
    for r in reviews[:MAX_TAPE_LINES]:
        prev = ""
        if r.get("prev_close") and "prev close" not in (r.get("reason") or ""):
            try:
                prev = f" (prev close ${float(r['prev_close']):,.2f})"
            except (TypeError, ValueError):
                prev = f" (prev close ${esc(r['prev_close'])})"
        detail = esc(r["reason"]) if r["reason"] else f"signal on {esc(r['symbol'])}"
        amount = f"${esc(r['dollars'])}" if r["dollars"] else "a small fractional"
        lines.append(
            f'<div class="tapeline"><span class="t">{esc(r["time"])}</span>'
            f'<span><span class="sym">{esc(r["symbol"])}</span> — {detail}{prev}. '
            f'Prepared {amount} {esc(r["side"])} for broker-side review — desk in review mode, nothing placed.</span></div>'
        )
    if len(reviews) > MAX_TAPE_LINES:
        more = len(reviews) - MAX_TAPE_LINES
        lines.append(
            f'<div class="tapeline"><span class="t">—</span>'
            f'<span>{more} more review entr{"y" if more == 1 else "ies"} recorded in the journal this day. '
            f'The full journal backs every line here.</span></div>'
        )
    if not lines:
        lines.append(
            '<div class="tapeline"><span class="t">all&nbsp;day</span>'
            '<span>Scanned the watchlist every cycle. No dip crossed the threshold, so the desk did '
            'nothing. Discipline is the feature.</span></div>'
        )
    return "\n".join(lines)


def render_status_card(snapshot, day):
    """Press-time desk status — only rendered onto the current day's page."""
    lane = bluechip_lane(snapshot)
    now_et = datetime.now(ET).strftime("%-I:%M %p ET on %B %-d, %Y")
    if not lane:
        return ""
    rows = [
        ("Lane status", lane.get("status") or "—"),
        ("Next action", (lane.get("nextAction") or "—").replace("_", " ")),
        ("Cycle cadence", f"every {lane.get('cadenceMinutes', '—')} minutes"),
        ("Consecutive failures", str(lane.get("consecutiveFailures", "—"))),
    ]
    rows_html = "".join(
        f"<p><strong>{esc(k)}:</strong> {esc(v)}</p>" for k, v in rows
    )
    return f"""
      <section class="section wrap">
        <p class="eyebrow">Desk status at press time</p>
        <div class="card">
          <p>Recorded {esc(now_et)}, from the same public snapshot that powers
             <a href="/fundmanager/">the live tape</a>. The Bluechip lane
             ({esc(lane.get("description") or "US equities desk")}):</p>
          {rows_html}
          <p>This block is a frozen record of what the dashboard said when this page went to press.
             For the desk as it is right now, always use the live tape.</p>
        </div>
      </section>
    """


def render_day_page(day, day_facts, snapshot=None, archived=False):
    display = fmt_display_date(day)
    weekday = fmt_weekday(day)
    n_rev = day_facts["reviewed"]
    n_sym = len(day_facts["symbols"])
    symbols = ", ".join(day_facts["symbols"]) if day_facts["symbols"] else "none"
    title = f"The Tape, Daily — {display} | EB28 Bluechip desk"
    if n_rev:
        description = (
            f"Shift report for {display}: {day_facts['cycles']} cycles, {n_rev} setups reviewed "
            f"({symbols}), {day_facts['placed']} orders placed. Full public record of the Bluechip desk."
        )
        lead = (
            f"{weekday}'s shift, straight from the desk journal: {day_facts['cycles']} cycles run, "
            f"{n_rev} dip setups prepared for broker-side review, {day_facts['placed']} orders placed. "
            f"Every line below is a real journal entry."
        )
    else:
        description = (
            f"Shift report for {display}: {day_facts['cycles']} cycles, no setups crossed the dip "
            f"threshold, {day_facts['placed']} orders placed. Full public record of the Bluechip desk."
        )
        lead = (
            f"{weekday}'s shift, straight from the desk journal: {day_facts['cycles']} cycles run and "
            f"no dip crossed the threshold — so the desk did nothing. That restraint is the product working."
        )

    archived_note = ""
    if archived:
        built = datetime.now(ET).strftime("%B %-d, %Y")
        archived_note = (
            f'<p style="color:var(--soft);font-size:.85rem;margin-top:1rem">Archive page rebuilt from '
            f'the desk journal on {built}. Live desk status was not archived for this date — the journal '
            f'entries above are the original records.</p>'
        )

    structured_data = [
        {
            "@context": "https://schema.org",
            "@type": "Article",
            "headline": f"The Tape, Daily — {display}",
            "description": description,
            "datePublished": day,
            "dateModified": day,
            "mainEntityOfPage": day_url(day),
            "author": {"@type": "Organization", "name": "EB28", "url": SITE_ORIGIN},
            "publisher": {"@type": "Organization", "name": "EB28", "url": SITE_ORIGIN},
        },
        {
            "@context": "https://schema.org",
            "@type": "BreadcrumbList",
            "itemListElement": [
                {"@type": "ListItem", "position": 1, "name": "Home", "item": f"{SITE_ORIGIN}/"},
                {"@type": "ListItem", "position": 2, "name": "The Tape, Daily", "item": f"{SITE_ORIGIN}/tape/"},
                {"@type": "ListItem", "position": 3, "name": display, "item": day_url(day)},
            ],
        },
    ]

    status_card = render_status_card(snapshot, day) if snapshot else ""

    body = f"""
      <section class="hero wrap">
        <span class="pill">EB28 Bluechip · daily shift report</span>
        <h1>The Tape, Daily — {esc(display)}</h1>
        <p class="lead">{esc(lead)}</p>
        <div class="meta-row">
          <span class="meta-chip">{esc(weekday)}</span>
          <span class="meta-chip">Mode: {esc(mode_label(day_facts))}</span>
          <span class="meta-chip">Watchlist: 8 blue-chip names</span>
        </div>
        <div class="stats">
          <div class="stat"><b>{day_facts["cycles"]}</b><span>cycles run</span></div>
          <div class="stat"><b>{n_rev}</b><span>setups reviewed</span></div>
          <div class="stat"><b>{day_facts["placed"]}</b><span>orders placed</span></div>
          <div class="stat"><b>{n_sym}</b><span>names flagged</span></div>
        </div>
      </section>

      <section class="section wrap">
        <div class="tapepanel">
          <div class="panel-head">
            <span class="panel-title">From the desk journal — {esc(display)}</span>
            <span class="livechip"><i></i>Desk on duty</span>
          </div>
          {render_tape_lines(day_facts)}
        </div>
        {archived_note}
      </section>

      {status_card}

      <section class="section wrap">
        <p class="eyebrow">How to read this page</p>
        <div class="grid">
          <div class="card">
            <h3>What a “review” is</h3>
            <p>The desk watches 8 blue-chip names. When one dips past its threshold, it prepares a small
               $5 fractional order and sends it to Robinhood's broker-side review step. In review mode
               that is where it stops — a human would have to confirm. Nothing is placed automatically.</p>
          </div>
          <div class="card">
            <h3>Why we publish quiet days</h3>
            <p>A tape that only shows action is a highlight reel. Most days a disciplined desk does very
               little, and we print those days too — the boring pages are the honest ones.</p>
          </div>
          <div class="card">
            <h3>Where the numbers come from</h3>
            <p>Every line is generated from the desk's own journal file — the same journal the operator
               reads. The <a href="/fundmanager/">live tape</a> shows the whole fund, updated every few minutes.</p>
          </div>
        </div>
        <div class="btnrow">
          <a class="btn" href="/fundmanager/">Watch the live tape</a>
          <a class="btn ghost" href="/tape/">All daily reports</a>
          <a class="btn ghost" href="/bluechip/">What is Bluechip?</a>
        </div>
      </section>
    """
    return page_shell(
        title=title, description=description, canonical=day_url(day),
        body=body, structured_data=structured_data, active="tape",
    )


def render_index(market_days):
    """docs/tape/ archive index. market_days: newest-first list of day facts."""
    total_reviews = sum(d["reviewed"] for d in market_days)
    total_cycles = sum(d["cycles"] for d in market_days)
    total_placed = sum(d["placed"] for d in market_days)
    latest = market_days[0]["date"] if market_days else ""
    title = "The Tape, Daily — Bluechip desk shift reports | EB28"
    description = (
        "One page per market day: every cycle, every setup reviewed, every order placed by the EB28 "
        "Bluechip desk — quiet days included. The full archive of the public tape."
    )
    cards = []
    for d in market_days:
        symbols = ", ".join(d["symbols"][:4]) if d["symbols"] else "no names flagged"
        cards.append(f"""
          <a class="card" href="/tape/{d["date"]}/">
            <span class="kicker">{esc(fmt_weekday(d["date"]))}</span>
            <h3>{esc(fmt_display_date(d["date"]))}</h3>
            <p>{d["cycles"]} cycles · {d["reviewed"]} setups reviewed · {d["placed"]} placed · {esc(symbols)}</p>
            <span class="read">Read the shift report →</span>
          </a>
        """)
    structured_data = [
        {
            "@context": "https://schema.org",
            "@type": "CollectionPage",
            "name": "The Tape, Daily",
            "url": f"{SITE_ORIGIN}/tape/",
            "description": description,
            "publisher": {"@type": "Organization", "name": "EB28", "url": SITE_ORIGIN},
        },
        {
            "@context": "https://schema.org",
            "@type": "BreadcrumbList",
            "itemListElement": [
                {"@type": "ListItem", "position": 1, "name": "Home", "item": f"{SITE_ORIGIN}/"},
                {"@type": "ListItem", "position": 2, "name": "The Tape, Daily", "item": f"{SITE_ORIGIN}/tape/"},
            ],
        },
    ]
    body = f"""
      <section class="hero wrap">
        <span class="pill">EB28 Bluechip · public archive</span>
        <h1>The Tape, Daily</h1>
        <p class="lead">One page per market day: what the desk reviewed, what it placed, and what it
          deliberately did not do. Generated straight from the desk journal — quiet days included,
          because a tape that skips the boring parts is just marketing.</p>
        <div class="stats">
          <div class="stat"><b>{len(market_days)}</b><span>market days on record</span></div>
          <div class="stat"><b>{total_cycles}</b><span>cycles run</span></div>
          <div class="stat"><b>{total_reviews}</b><span>setups reviewed</span></div>
          <div class="stat"><b>{total_placed}</b><span>orders placed</span></div>
        </div>
        <div class="btnrow">
          <a class="btn" href="/fundmanager/">Watch the live tape</a>
          <a class="btn ghost" href="/answers/">Trading-bot questions, answered</a>
        </div>
      </section>
      <section class="section wrap">
        <p class="eyebrow">Latest shift reports</p>
        <div class="grid">
          {"".join(cards)}
        </div>
      </section>
    """
    page = page_shell(
        title=title, description=description, canonical=f"{SITE_ORIGIN}/tape/",
        body=body, structured_data=structured_data, active="tape",
    )
    return page, latest


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--date", help="render a single day (YYYY-MM-DD)")
    parser.add_argument("--backfill", type=int, default=0, help="render missing pages for last N days")
    parser.add_argument("--no-push", action="store_true")
    parser.add_argument("--rebuild", action="store_true", help="re-render pages that already exist")
    args = parser.parse_args()

    today = datetime.now(ET).strftime("%Y-%m-%d")

    # ---- fail-closed gates ----
    snapshot = load_snapshot()          # raises on missing/stale
    days = load_journal_days()          # raises on missing journal

    if args.backfill:
        start = date.fromisoformat(today) - timedelta(days=args.backfill)
        targets = sorted(
            d for d in days
            if date.fromisoformat(d) >= start and d <= today and is_market_day(d)
        )
    else:
        target = args.date or today
        if not is_market_day(target):
            print(f"[skip] {target} is not a market day — nothing to publish")
            return
        if target not in days:
            print(f"[skip] no journal entries for {target} — nothing to publish")
            return
        targets = [target]

    if not targets:
        print("[skip] no market days with journal data in range")
        return

    # ---- render (in memory first: lint everything before writing anything) ----
    rendered = []
    for day in targets:
        out = TAPE_DIR / day / "index.html"
        if out.exists() and not args.rebuild:
            print(f"[keep] {day} already published")
            continue
        is_today = day == today
        html = render_day_page(
            day, days[day],
            snapshot=snapshot if is_today else None,
            archived=not is_today,
        )
        rendered.append((day, out, html))

    market_days = sorted(
        (d for k, d in days.items() if is_market_day(k) and k <= today),
        key=lambda d: d["date"], reverse=True,
    )
    index_html, latest = render_index(market_days)

    # Compliance gate — every page, fail closed, before any file is written.
    for day, _, html in rendered:
        lint_or_die(f"tape page {day}", html)
    lint_or_die("tape index", index_html)

    # ---- write ----
    for day, out, html in rendered:
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(html)
        print(f"[write] {out.relative_to(REPO)}")
    TAPE_DIR.mkdir(parents=True, exist_ok=True)
    (TAPE_DIR / "index.html").write_text(index_html)

    manifest = {
        "generatedAt": datetime.now(ET).isoformat(),
        "days": [
            {"date": d["date"], "cycles": d["cycles"], "reviewed": d["reviewed"],
             "placed": d["placed"], "live": d["live"], "symbols": d["symbols"],
             "url": day_url(d["date"])}
            for d in market_days
        ],
    }
    TAPE_MANIFEST_PATH.write_text(json.dumps(manifest, indent=2) + "\n")

    update_sitemap(
        [(f"{SITE_ORIGIN}/tape/", latest)]
        + [(day_url(d["date"]), d["date"]) for d in market_days]
    )

    # ---- publish ----
    label = f"backfill {len(rendered)} day(s)" if args.backfill else targets[0]
    git_publish(
        ["tape", "data/tape-days.json", "sitemap.xml"],
        f"The Tape, Daily: {label}",
        push=not args.no_push,
    )
    print(f"[done] {len(rendered)} page(s) rendered, index covers {len(market_days)} market days")


if __name__ == "__main__":
    try:
        main()
    except GateError as err:
        print(f"FAIL-CLOSED: {err}", file=sys.stderr)
        sys.exit(1)
