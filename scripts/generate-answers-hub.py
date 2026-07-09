#!/usr/bin/env python3
"""DayTradingBot.net /answers — programmatic SEO hub for retail-trader trust questions.

Content lives in content/answers.json (hand-authored seed cluster).
This script renders answers/<slug>/index.html + answers/index.html
in the daylight design language, injecting FIRST-PARTY TAPE DATA into every
page it renders (Google's March 2026 scaled-content enforcement: no page
ships without first-party data, growth capped at 1-3 changed pages/day).

Modes:
  --seed      one-time bootstrap: publish the first 3 queued entries
              (the daily cap), render, lint, publish
  --nightly   publish 1 queued entry + refresh the 2 stalest published
              entries (fresh tape data + visible last-updated bump)
  --render-only  re-render currently-published pages without state changes

Fail-closed: missing/stale snapshot, missing journal, or any compliance
lint violation aborts before anything is written or committed.

Runs via launchd label net.daytradingbot.answers.nightly (daily 20:45 ET).
"""
import argparse
import json
import sys
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from eb28_growth_lib import (  # noqa: E402
    DOCS, ET, GateError, REPO, SITE_ORIGIN,
    esc, fmt_display_date, git_publish, is_market_day, lint_or_die,
    load_journal_days, load_snapshot, page_shell, update_sitemap,
)

ANSWERS_FILE = REPO / "content" / "answers.json"
ANSWERS_DIR = DOCS / "answers"
SEED_PUBLISH_COUNT = 3  # one-time bootstrap, within the 1-3 pages/day cap


def answer_url(slug):
    return f"{SITE_ORIGIN}/answers/{slug}/"


def tape_stats():
    """First-party tape numbers injected into every rendered page."""
    days = load_journal_days()
    market_days = [d for k, d in days.items() if is_market_day(k)]
    return {
        "asOf": datetime.now(ET).strftime("%B %-d, %Y"),
        "marketDays": len(market_days),
        "cycles": sum(d["cycles"] for d in market_days),
        "reviewed": sum(d["reviewed"] for d in market_days),
        "placed": sum(d["placed"] for d in market_days),
        "mode": "live" if any(d["live"] for d in market_days) else "review-only (paper)",
    }


def render_tape_block(stats):
    return f"""
      <section class="section wrap">
        <p class="eyebrow">First-party data — from our own desk</p>
        <div class="tapepanel">
          <div class="panel-head">
            <span class="panel-title">The EB28 Bluechip tape, as of {esc(stats["asOf"])}</span>
            <span class="livechip"><i></i>Public record</span>
          </div>
          <div class="tapeline"><span class="t">record</span><span>{stats["marketDays"]} market days journaled ·
            {stats["cycles"]} cycles run · {stats["reviewed"]} setups reviewed · {stats["placed"]} orders placed ·
            mode: {esc(stats["mode"])}</span></div>
          <div class="tapeline"><span class="t">why</span><span>We publish this on every answer page because advice
            about verifying trading software rings hollow without a record of our own to check. Quiet days and
            warnings included.</span></div>
          <div class="tapeline"><span class="t">check</span><span>Live dashboard: <a href="/fundmanager/"
            style="color:#fbbf24">eb28.co/fundmanager</a> · daily archive: <a href="/tape/"
            style="color:#fbbf24">eb28.co/tape</a></span></div>
        </div>
      </section>
    """


def render_answer_page(entry, entries_by_slug, stats):
    slug = entry["slug"]
    canonical = answer_url(slug)
    published = entry.get("datePublished") or datetime.now(ET).strftime("%Y-%m-%d")
    modified = entry.get("dateModified") or published

    faq_entities = [{
        "@type": "Question",
        "name": entry["question"],
        "acceptedAnswer": {"@type": "Answer", "text": entry["shortAnswer"]},
    }]
    for faq in entry.get("faqs", []):
        faq_entities.append({
            "@type": "Question",
            "name": faq["question"],
            "acceptedAnswer": {"@type": "Answer", "text": faq["answer"]},
        })
    structured_data = [
        {"@context": "https://schema.org", "@type": "FAQPage", "mainEntity": faq_entities},
        {
            "@context": "https://schema.org",
            "@type": "Article",
            "headline": entry["title"],
            "description": entry["shortAnswer"][:300],
            "datePublished": published,
            "dateModified": modified,
            "mainEntityOfPage": canonical,
            "author": {"@type": "Organization", "name": "EB28", "url": SITE_ORIGIN},
            "publisher": {"@type": "Organization", "name": "EB28", "url": SITE_ORIGIN},
        },
        {
            "@context": "https://schema.org",
            "@type": "BreadcrumbList",
            "itemListElement": [
                {"@type": "ListItem", "position": 1, "name": "Home", "item": f"{SITE_ORIGIN}/"},
                {"@type": "ListItem", "position": 2, "name": "Answers", "item": f"{SITE_ORIGIN}/answers/"},
                {"@type": "ListItem", "position": 3, "name": entry["question"], "item": canonical},
            ],
        },
    ]

    sections_html = []
    for section in entry.get("sections", []):
        body = "".join(f"<p>{esc(p)}</p>" for p in section.get("body", []))
        bullets = ""
        if section.get("bullets"):
            bullets = "<ul>" + "".join(f"<li>{esc(b)}</li>" for b in section["bullets"]) + "</ul>"
        sections_html.append(
            f'<section class="section wrap"><h2>{esc(section["heading"])}</h2>{body}{bullets}</section>'
        )

    faqs_html = ""
    if entry.get("faqs"):
        items = "".join(
            f'<details><summary>{esc(f["question"])}</summary><p>{esc(f["answer"])}</p></details>'
            for f in entry["faqs"]
        )
        faqs_html = f'<section class="section wrap faq"><h2>More questions people ask</h2>{items}</section>'

    sources_html = ""
    if entry.get("sources"):
        items = "".join(
            f'<li><a href="{esc(s["url"])}" rel="noopener noreferrer" target="_blank">{esc(s["label"])}</a></li>'
            for s in entry["sources"]
        )
        sources_html = f"""
          <section class="section wrap sources">
            <h2>Regulator resources and sources</h2>
            <p>Independent, official reading — not affiliated with EB28:</p>
            <ul>{items}</ul>
          </section>
        """

    related_html = ""
    related = [entries_by_slug[s] for s in entry.get("related", [])
               if s in entries_by_slug and entries_by_slug[s].get("status") == "published"]
    if related:
        cards = "".join(
            f'<a class="card" href="/answers/{esc(r["slug"])}/"><span class="kicker">Related answer</span>'
            f'<h3>{esc(r["question"])}</h3><span class="read">Read the answer →</span></a>'
            for r in related
        )
        related_html = f"""
          <section class="section wrap">
            <p class="eyebrow">Keep going</p>
            <div class="grid">{cards}</div>
          </section>
        """

    body = f"""
      <section class="hero wrap">
        <span class="pill">EB28 Answers · retail trading trust</span>
        <h1>{esc(entry["question"])}</h1>
        <div class="shortanswer">
          <span class="label">Short answer</span>
          {esc(entry["shortAnswer"])}
        </div>
        <div class="meta-row">
          <span class="meta-chip">Last updated {esc(fmt_display_date(modified))}</span>
          <span class="meta-chip">First published {esc(fmt_display_date(published))}</span>
          <span class="meta-chip">Backed by our public tape</span>
        </div>
      </section>
      {"".join(sections_html)}
      {render_tape_block(stats)}
      {faqs_html}
      {sources_html}
      {related_html}
      <section class="section wrap">
        <div class="btnrow">
          <a class="btn" href="/fundmanager/">Watch our live tape</a>
          <a class="btn ghost" href="/answers/">All answers</a>
          <a class="btn ghost" href="/bluechip/">The desk behind this site</a>
        </div>
      </section>
    """
    return page_shell(
        title=f"{entry['title']} | EB28 Answers",
        description=entry["shortAnswer"][:300],
        canonical=canonical, body=body,
        structured_data=structured_data, active="answers",
    )


def render_index(published_entries, stats):
    title = "Answers: straight talk on trading bots and automated trading | EB28"
    description = (
        "Plain-English answers to the questions retail traders actually ask about trading bots — "
        "safety, legality, scams, track records — each one backed by our own public tape."
    )
    cards = "".join(
        f'<a class="card" href="/answers/{esc(e["slug"])}/">'
        f'<span class="kicker">Updated {esc(fmt_display_date(e.get("dateModified") or e.get("datePublished")))}</span>'
        f'<h3>{esc(e["question"])}</h3><p>{esc(e["shortAnswer"][:160])}…</p>'
        f'<span class="read">Read the answer →</span></a>'
        for e in published_entries
    )
    structured_data = [
        {
            "@context": "https://schema.org",
            "@type": "CollectionPage",
            "name": "EB28 Answers",
            "url": f"{SITE_ORIGIN}/answers/",
            "description": description,
            "publisher": {"@type": "Organization", "name": "EB28", "url": SITE_ORIGIN},
        },
        {
            "@context": "https://schema.org",
            "@type": "BreadcrumbList",
            "itemListElement": [
                {"@type": "ListItem", "position": 1, "name": "Home", "item": f"{SITE_ORIGIN}/"},
                {"@type": "ListItem", "position": 2, "name": "Answers", "item": f"{SITE_ORIGIN}/answers/"},
            ],
        },
    ]
    body = f"""
      <section class="hero wrap">
        <span class="pill">EB28 Answers</span>
        <h1>Trading-bot questions, answered without the hype</h1>
        <p class="lead">The questions retail traders actually type into a search bar — safety, legality,
          scams, track records — answered in plain English by a team that runs its own desk in public.
          Every page carries data from our live tape, and none of it is investment advice.</p>
        <div class="stats">
          <div class="stat"><b>{len(published_entries)}</b><span>answers live</span></div>
          <div class="stat"><b>{stats["marketDays"]}</b><span>market days on our tape</span></div>
          <div class="stat"><b>{stats["reviewed"]}</b><span>setups reviewed</span></div>
          <div class="stat"><b>{stats["placed"]}</b><span>orders placed</span></div>
        </div>
        <div class="btnrow">
          <a class="btn" href="/fundmanager/">Watch the live tape</a>
          <a class="btn ghost" href="/tape/">Daily shift reports</a>
        </div>
      </section>
      <section class="section wrap">
        <p class="eyebrow">All answers</p>
        <div class="grid">{cards}</div>
      </section>
    """
    return page_shell(
        title=title, description=description, canonical=f"{SITE_ORIGIN}/answers/",
        body=body, structured_data=structured_data, active="answers",
    )


def main():
    parser = argparse.ArgumentParser()
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--seed", action="store_true")
    mode.add_argument("--nightly", action="store_true")
    mode.add_argument("--render-only", action="store_true")
    parser.add_argument("--no-push", action="store_true")
    args = parser.parse_args()

    today = datetime.now(ET).strftime("%Y-%m-%d")

    # ---- fail-closed gates: no fresh first-party data, no publishing ----
    load_snapshot()
    stats = tape_stats()

    data = json.loads(ANSWERS_FILE.read_text())
    entries = data["entries"]
    by_slug = {e["slug"]: e for e in entries}
    queued = sorted((e for e in entries if e.get("status") == "queued"),
                    key=lambda e: e.get("queueOrder", 999))
    published = [e for e in entries if e.get("status") == "published"]

    to_render = []  # entries whose page files change this run

    if args.seed:
        fresh = [e for e in published if not e.get("datePublished")]
        room = SEED_PUBLISH_COUNT - len(fresh)
        for entry in queued[:max(0, room)]:
            entry["status"] = "published"
            fresh.append(entry)
        for entry in fresh:
            entry["datePublished"] = entry["datePublished"] or today
            entry["dateModified"] = today
            to_render.append(entry)
    elif args.nightly:
        # Publish 1 new page — unless one already went out today (idempotent).
        published_today = [e for e in published if e.get("datePublished") == today]
        if not published_today and queued:
            entry = queued[0]
            entry["status"] = "published"
            entry["datePublished"] = today
            entry["dateModified"] = today
            to_render.append(entry)
            print(f"[publish] {entry['slug']}")
        elif published_today:
            print("[cap] a page was already published today — no new page")
        else:
            print("[queue] empty — no new page to publish")
        # Refresh the 2 stalest published pages (fresh tape data + date bump).
        stale = sorted(
            (e for e in published if e.get("dateModified") != today),
            key=lambda e: e.get("dateModified") or "",
        )
        for entry in stale[:2]:
            entry["dateModified"] = today
            to_render.append(entry)
            print(f"[refresh] {entry['slug']}")
    else:  # --render-only
        to_render = [e for e in entries if e.get("status") == "published"]

    published = [e for e in entries if e.get("status") == "published"]
    published.sort(key=lambda e: (e.get("datePublished") or "", e.get("queueOrder", 0)))

    if not published:
        print("[skip] nothing published yet")
        return

    # ---- render in memory, lint everything, then write ----
    rendered = [(e, render_answer_page(e, by_slug, stats)) for e in to_render]
    index_html = render_index(list(reversed(published)), stats)

    for entry, html in rendered:
        lint_or_die(f"answers page {entry['slug']}", html)
    lint_or_die("answers index", index_html)

    for entry, html in rendered:
        out = ANSWERS_DIR / entry["slug"] / "index.html"
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(html)
        print(f"[write] {out.relative_to(REPO)}")
    ANSWERS_DIR.mkdir(parents=True, exist_ok=True)
    (ANSWERS_DIR / "index.html").write_text(index_html)

    if not args.render_only:
        ANSWERS_FILE.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n")

    newest = max((e.get("dateModified") or "" for e in published), default="")
    update_sitemap(
        [(f"{SITE_ORIGIN}/answers/", newest)]
        + [(answer_url(e["slug"]), e.get("dateModified") or e.get("datePublished") or "")
           for e in published]
    )

    changed = ", ".join(e["slug"] for e in to_render) or "index only"
    git_publish(
        ["answers", "sitemap.xml", "content/answers.json"],
        f"Answers hub: {changed[:180]}",
        push=not args.no_push,
    )
    print(f"[done] {len(rendered)} page(s) rendered, {len(published)} live, {len(queued)} queued")


if __name__ == "__main__":
    try:
        main()
    except GateError as err:
        print(f"FAIL-CLOSED: {err}", file=sys.stderr)
        sys.exit(1)
