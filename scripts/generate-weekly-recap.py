#!/usr/bin/env python3
"""Sunday weekly recap: aggregate the week's tape into a /weekly/ page.

Reads the same desk journal that powers /tape/, builds one recap page for
the Monday–Sunday week just ended at weekly/YYYY-MM-DD/index.html (dated by
the Sunday), plus a /weekly/ archive index — all on daytradingbot.net in
the Bluechip daylight design language, with Article + FAQPage JSON-LD.

Fail-closed: stale/missing snapshot or journal aborts; every rendered page
must pass scripts/compliance_lint.py or nothing is written or committed.

Usage:
  generate-weekly-recap.py                      # most recent Sunday
  generate-weekly-recap.py --week-ending 2026-07-05
  generate-weekly-recap.py ... --no-push
  generate-weekly-recap.py ... --rebuild        # re-render an existing week

Runs via launchd label net.daytradingbot.weekly (Sunday 17:00 ET).
"""
import argparse
import json
import sys
from datetime import datetime, date, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from eb28_growth_lib import (  # noqa: E402
    DATA_DIR, DOCS, ET, GateError, REPO, SITE_ORIGIN,
    esc, fmt_display_date, fmt_weekday, git_publish, is_market_day,
    lint_or_die, load_journal_days, load_snapshot, page_shell, update_sitemap,
)

WEEKLY_DIR = DOCS / "weekly"
MANIFEST_PATH = DATA_DIR / "weekly-recaps.json"


def week_url(week_ending):
    return f"{SITE_ORIGIN}/weekly/{week_ending}/"


def most_recent_sunday(today):
    return today - timedelta(days=(today.weekday() + 1) % 7)


def week_days(week_ending, journal_days):
    monday = week_ending - timedelta(days=6)
    out = []
    for i in range(7):
        d = (monday + timedelta(days=i)).isoformat()
        if d in journal_days and is_market_day(d):
            out.append(journal_days[d])
    return out


def week_facts(week_ending, days):
    """week_ending is a datetime.date (a Sunday)."""
    monday = week_ending - timedelta(days=6)
    friday = week_ending - timedelta(days=2)
    symbols = []
    for d in days:
        for s in d["symbols"]:
            if s not in symbols:
                symbols.append(s)
    return {
        "weekEnding": week_ending.isoformat(),
        "span": f"{monday.strftime('%B %-d')} – {friday.strftime('%B %-d, %Y')}",
        "marketDays": len(days),
        "cycles": sum(d["cycles"] for d in days),
        "reviewed": sum(d["reviewed"] for d in days),
        "placed": sum(d["placed"] for d in days),
        "symbols": symbols,
        "live": any(d["live"] for d in days),
    }


def render_week_page(facts, days):
    week_ending = facts["weekEnding"]
    span = facts["span"]
    mode = "live" if facts["live"] else "review-only (paper) mode"
    title = f"The Tape, Weekly: Desk Recap for {span} | DayTradingBot.net"
    description = (
        f"Weekly recap from the public tape: {facts['cycles']} cycles, {facts['reviewed']} setups "
        f"reviewed, {facts['placed']} orders placed across {facts['marketDays']} market days ({span}). "
        f"Every number links to a daily shift report anyone can audit."
    )
    lead = (
        f"What the desk actually did during the week of {span}: every cycle, every setup reviewed, "
        f"every order placed — and the quiet stretches in between — aggregated from the daily shift "
        f"reports on the public tape."
    )

    if facts["symbols"]:
        flagged_para = (
            f"Across the week the desk flagged dips in {', '.join(facts['symbols'])} — "
            f"{facts['reviewed']} individual setups in total, each one prepared as a small $5 "
            f"fractional order and sent to Robinhood's broker-side review step. Because the desk "
            f"runs in {mode}, that is where each one stopped: prepared, journaled, and not placed. "
            f"The point of the beta is the record, not the volume."
        )
    else:
        flagged_para = (
            "No dip crossed the desk's threshold this week, so it prepared nothing — a full week of "
            "scanning, journaling, and deliberately doing nothing. We publish those weeks too, because "
            "a desk that only reports its busy weeks is running a highlight reel, not a tape."
        )

    day_rows = "\n".join(
        f'<div class="tapeline"><span class="t">{esc(fmt_weekday(d["date"]))}</span>'
        f'<span><a href="/tape/{d["date"]}/" style="color:#e2e8f0">{esc(fmt_display_date(d["date"]))}</a>'
        f' — {d["cycles"]} cycles, {d["reviewed"]} setups reviewed, {d["placed"]} orders placed'
        f'{" (" + ", ".join(esc(s) for s in d["symbols"][:4]) + ")" if d["symbols"] else ""}</span></div>'
        for d in days
    )

    faqs = [
        {
            "question": "Where do these weekly numbers come from?",
            "answer": (
                "From the desk's own journal file, aggregated by the same script that renders the "
                "daily pages at daytradingbot.net/tape. Nothing is hand-edited between the journal "
                "and this page."
            ),
        },
        {
            "question": "Why were no orders placed this week?" if facts["placed"] == 0 else
                        "How are placed orders reviewed?",
            "answer": (
                "The desk runs in review-only mode during the public beta: it prepares real orders "
                "through Robinhood's official Agentic Trading API and stops at the broker-side review "
                "step, so every decision is journaled with zero execution. That is deliberate — the "
                "beta exists to build a record, not volume." if facts["placed"] == 0 else
                "Every order passes Robinhood's broker-side review step before it reaches the market, "
                "and every one is journaled to the public tape, wins and losses in the same font."
            ),
        },
        {
            "question": "Is this recap investment advice?",
            "answer": (
                "No. It is a factual report of what our own software did during one week, published "
                "for transparency. We never recommend trades or predict outcomes, and trading always "
                "involves risk of loss."
            ),
        },
    ]
    faqs_html = "".join(
        f'<details><summary>{esc(f["question"])}</summary><p>{esc(f["answer"])}</p></details>'
        for f in faqs
    )

    sources = [
        ("CFTC customer advisory: criminals' increasing use of generative AI in fraud",
         "https://www.cftc.gov/LearnAndProtect/AdvisoriesAndArticles/AI_Fraud.html"),
        ("FINRA investor insights", "https://www.finra.org/investors/insights"),
        ("SEC / Investor.gov alerts and bulletins",
         "https://www.investor.gov/introduction-investing/general-resources/news-alerts/alerts-bulletins"),
    ]
    sources_html = "".join(
        f'<li><a href="{esc(u)}" rel="noopener noreferrer" target="_blank">{esc(l)}</a></li>'
        for l, u in sources
    )

    structured_data = [
        {
            "@context": "https://schema.org",
            "@type": "Article",
            "headline": f"The Tape, Weekly: Desk Recap for {span}",
            "description": description,
            "datePublished": week_ending,
            "dateModified": week_ending,
            "mainEntityOfPage": week_url(week_ending),
            "author": {"@type": "Organization", "name": "EB28", "url": SITE_ORIGIN},
            "publisher": {"@type": "Organization", "name": "EB28", "url": SITE_ORIGIN},
        },
        {
            "@context": "https://schema.org",
            "@type": "FAQPage",
            "mainEntity": [
                {"@type": "Question", "name": f["question"],
                 "acceptedAnswer": {"@type": "Answer", "text": f["answer"]}}
                for f in faqs
            ],
        },
        {
            "@context": "https://schema.org",
            "@type": "BreadcrumbList",
            "itemListElement": [
                {"@type": "ListItem", "position": 1, "name": "Home", "item": f"{SITE_ORIGIN}/"},
                {"@type": "ListItem", "position": 2, "name": "The Tape, Weekly", "item": f"{SITE_ORIGIN}/weekly/"},
                {"@type": "ListItem", "position": 3, "name": span, "item": week_url(week_ending)},
            ],
        },
    ]

    body = f"""
      <section class="hero wrap">
        <span class="pill">Weekly tape recap</span>
        <h1>The Tape, Weekly: {esc(span)}</h1>
        <p class="lead">{esc(lead)}</p>
        <div class="meta-row">
          <span class="meta-chip">Week ending {esc(fmt_display_date(week_ending))}</span>
          <span class="meta-chip">Mode: {esc("Live" if facts["live"] else "Review-only (paper)")}</span>
        </div>
        <div class="stats">
          <div class="stat"><b>{facts["marketDays"]}</b><span>market days</span></div>
          <div class="stat"><b>{facts["cycles"]}</b><span>cycles run</span></div>
          <div class="stat"><b>{facts["reviewed"]}</b><span>setups reviewed</span></div>
          <div class="stat"><b>{facts["placed"]}</b><span>orders placed</span></div>
        </div>
      </section>

      <section class="section wrap">
        <p class="eyebrow">Day by day</p>
        <div class="tapepanel">
          <div class="panel-head">
            <span class="panel-title">From the daily shift reports — {esc(span)}</span>
            <span class="livechip"><i></i>Public record</span>
          </div>
          {day_rows}
        </div>
        <p style="color:var(--soft);font-size:.85rem;margin-top:1rem">These are journal counts, not
          marketing numbers. Each line links to a full shift report where the individual entries are
          printed in order.</p>
      </section>

      <section class="section wrap">
        <h2>What the desk flagged</h2>
        <p>{esc(flagged_para)}</p>
        <p>A review entry records the moment a watched name dipped past the desk's threshold: the
          signal, the quote context at that second, the order it drafted, and the broker-side checks
          that ran. Reading a handful of them is the fastest way to understand the desk's temperament —
          start with any daily page in <a href="/tape/">the archive</a>.</p>
      </section>

      <section class="section wrap">
        <h2>Why we publish the boring weeks</h2>
        <p>Most trading products show you their best week. We publish every week, because the whole
          argument for this desk is the record: something you can audit before you believe anything we
          say about it. Quiet weeks, degraded-status warnings, and zeros in the "placed" column are part
          of that record, not blemishes on it.</p>
        <div class="btnrow">
          <a class="btn" href="/fundmanager/">Watch the live tape</a>
          <a class="btn ghost" href="/weekly/">All weekly recaps</a>
          <a class="btn ghost" href="/answers/">Trading-bot questions, answered</a>
          <a class="btn ghost" href="/bluechip/">The desk behind this site</a>
        </div>
      </section>

      <section class="section wrap faq">
        <h2>FAQs</h2>
        {faqs_html}
      </section>

      <section class="section wrap sources">
        <h2>Regulator resources</h2>
        <p>Independent, official reading — not affiliated with EB28:</p>
        <ul>{sources_html}</ul>
      </section>
    """
    return page_shell(
        title=title, description=description, canonical=week_url(week_ending),
        body=body, structured_data=structured_data, active="weekly",
    )


def render_index(recaps):
    """/weekly/ archive index. recaps: newest-first list of week facts."""
    title = "The Tape, Weekly — desk recaps | DayTradingBot.net"
    description = (
        "One recap per week: what the desk reviewed, what it placed, and what it deliberately did "
        "not do — aggregated from the daily shift reports on the public tape."
    )
    cards = "".join(
        f'<a class="card" href="/weekly/{esc(r["weekEnding"])}/">'
        f'<span class="kicker">Week ending {esc(fmt_display_date(r["weekEnding"]))}</span>'
        f'<h3>{esc(r["span"])}</h3>'
        f'<p>{r["marketDays"]} market days · {r["cycles"]} cycles · {r["reviewed"]} setups reviewed · '
        f'{r["placed"]} placed</p>'
        f'<span class="read">Read the recap →</span></a>'
        for r in recaps
    )
    structured_data = [
        {
            "@context": "https://schema.org",
            "@type": "CollectionPage",
            "name": "The Tape, Weekly",
            "url": f"{SITE_ORIGIN}/weekly/",
            "description": description,
            "publisher": {"@type": "Organization", "name": "EB28", "url": SITE_ORIGIN},
        },
        {
            "@context": "https://schema.org",
            "@type": "BreadcrumbList",
            "itemListElement": [
                {"@type": "ListItem", "position": 1, "name": "Home", "item": f"{SITE_ORIGIN}/"},
                {"@type": "ListItem", "position": 2, "name": "The Tape, Weekly", "item": f"{SITE_ORIGIN}/weekly/"},
            ],
        },
    ]
    body = f"""
      <section class="hero wrap">
        <span class="pill">DayTradingBot · weekly recaps</span>
        <h1>The Tape, Weekly</h1>
        <p class="lead">Every Sunday, the week's tape gets aggregated into one recap: cycles, setups,
          orders, and the discipline in between. Generated straight from the desk journal — quiet weeks
          included.</p>
        <div class="btnrow">
          <a class="btn" href="/fundmanager/">Watch the live tape</a>
          <a class="btn ghost" href="/tape/">Daily shift reports</a>
        </div>
      </section>
      <section class="section wrap">
        <p class="eyebrow">All recaps</p>
        <div class="grid">{cards}</div>
      </section>
    """
    return page_shell(
        title=title, description=description, canonical=f"{SITE_ORIGIN}/weekly/",
        body=body, structured_data=structured_data, active="weekly",
    )


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--week-ending", help="Sunday of the week to recap (YYYY-MM-DD)")
    parser.add_argument("--no-push", action="store_true")
    parser.add_argument("--rebuild", action="store_true")
    args = parser.parse_args()

    today = datetime.now(ET).date()
    week_ending = (date.fromisoformat(args.week_ending) if args.week_ending
                   else most_recent_sunday(today))
    if week_ending.weekday() != 6:
        raise GateError(f"--week-ending must be a Sunday, got {week_ending} ({week_ending.strftime('%A')})")

    # ---- fail-closed gates ----
    load_snapshot()
    journal_days = load_journal_days()

    out = WEEKLY_DIR / week_ending.isoformat() / "index.html"
    if out.exists() and not args.rebuild:
        print(f"[skip] recap already published: /weekly/{week_ending}/")
        return

    days = week_days(week_ending, journal_days)
    if not days:
        print(f"[skip] no market-day journal data for week ending {week_ending} — nothing to recap")
        return

    facts = week_facts(week_ending, days)
    page_html = render_week_page(facts, days)

    # Manifest: merge this week in, newest first.
    manifest = {"recaps": []}
    if MANIFEST_PATH.exists():
        try:
            manifest = json.loads(MANIFEST_PATH.read_text())
        except Exception:
            pass
    recaps = [r for r in manifest.get("recaps", []) if r.get("weekEnding") != facts["weekEnding"]]
    recaps.append(facts)
    recaps.sort(key=lambda r: r["weekEnding"], reverse=True)
    index_html = render_index(recaps)

    # Compliance gate — every page, fail closed, before any file is written.
    lint_or_die(f"weekly recap {week_ending}", page_html)
    lint_or_die("weekly index", index_html)

    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(page_html)
    print(f"[write] {out.relative_to(REPO)}")
    WEEKLY_DIR.mkdir(parents=True, exist_ok=True)
    (WEEKLY_DIR / "index.html").write_text(index_html)
    MANIFEST_PATH.write_text(json.dumps(
        {"generatedAt": datetime.now(ET).isoformat(), "recaps": recaps},
        indent=2) + "\n")

    update_sitemap(
        [(f"{SITE_ORIGIN}/weekly/", recaps[0]["weekEnding"])]
        + [(week_url(r["weekEnding"]), r["weekEnding"]) for r in recaps]
    )

    git_publish(
        ["weekly", "data/weekly-recaps.json", "sitemap.xml"],
        f"Weekly tape recap: week ending {week_ending}",
        push=not args.no_push,
    )
    print(f"[done] {week_url(week_ending.isoformat())}")


if __name__ == "__main__":
    try:
        main()
    except GateError as err:
        print(f"FAIL-CLOSED: {err}", file=sys.stderr)
        sys.exit(1)
