#!/usr/bin/env python3
"""Shared library for the DayTradingBot.net full-auto growth systems.

Used by:
  generate-tape-daily.py    — "The Tape, Daily" pages under /tape/
  generate-answers-hub.py   — /answers programmatic SEO hub
  generate-weekly-recap.py  — Sunday recap pages under /weekly/

This repo IS the site: GitHub Pages serves the repository root on main
(CNAME daytradingbot.net). The fund snapshot is read from the eb28.co
checkout on this machine, where ai.eb28.fundmanager.publisher refreshes it
every 5 minutes — the data/ copy in this repo is a static export, never
read for freshness-gated publishing.

Design rules baked in here:
  - Daylight design language of the Bluechip funnel (slate-50 canvas, white
    cards, orange CTA, amber tape banner, dark tape panel).
  - Every rendered page must pass scripts/compliance_lint.py — fail closed.
  - Every page carries the standard software-not-advice / risk-of-loss
    disclaimer.
  - Publishing = git commit of ONLY the generated paths + push to main.
    Other sessions commit to this repo too; never stage anything outside
    the explicit path list.
"""
import json
import subprocess
import sys
from datetime import datetime, date, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

HOME = Path.home()
REPO = Path(__file__).resolve().parent.parent
DOCS = REPO  # site is served from the repository root
DATA_DIR = REPO / "data"
SITE_ORIGIN = "https://daytradingbot.net"

SNAPSHOT_PATH = HOME / "GITHUB/eb28.co/docs/data/fundmanager-public.json"
JOURNAL_PATH = HOME / ".openclaw/workspace-dev/skills/robinhood-equities/journal.jsonl"
TAPE_MANIFEST_PATH = DATA_DIR / "tape-days.json"

ET = ZoneInfo("America/New_York")

# NYSE full-close holidays (no tape page on these days).
NYSE_HOLIDAYS = {
    # 2026
    "2026-01-01", "2026-01-19", "2026-02-16", "2026-04-03", "2026-05-25",
    "2026-06-19", "2026-07-03", "2026-09-07", "2026-11-26", "2026-12-25",
    # 2027
    "2027-01-01", "2027-01-18", "2027-02-15", "2027-03-26", "2027-05-31",
    "2027-06-18", "2027-07-05", "2027-09-06", "2027-11-25", "2027-12-24",
}

DISCLAIMER_HTML = (
    "<strong>Software, not advice.</strong> Bluechip (the desk behind DayTradingBot.net, by EB28) "
    "is licensed software that you install and operate yourself. Nothing on this page is investment "
    "advice, an offer, or a recommendation to buy or sell any security. Trading involves risk of loss: "
    "you can lose money, including everything you put in. Activity shown here is a record of past "
    "activity from our own desk and is not a prediction of future results. Robinhood and related marks "
    "belong to their owner, which does not endorse or sponsor EB28, Bluechip, or DayTradingBot.net."
)


class GateError(RuntimeError):
    """A fail-closed gate tripped. Nothing may be published."""


# ---------------------------------------------------------------- gates ----

def lint_or_die(label, text):
    sys.path.insert(0, str(Path(__file__).parent))
    from compliance_lint import lint
    violations = lint(text)
    if violations:
        lines = "\n".join(f"  ✗ {v}" for v in violations)
        raise GateError(f"compliance lint BLOCKED {label}:\n{lines}")


def load_snapshot(max_age_minutes=60):
    """Load the live fund snapshot, fail closed on missing/stale."""
    if not SNAPSHOT_PATH.exists():
        raise GateError(f"snapshot missing: {SNAPSHOT_PATH}")
    try:
        snap = json.loads(SNAPSHOT_PATH.read_text())
    except Exception as err:
        raise GateError(f"snapshot unreadable: {err}")
    if snap.get("ok") is not True:
        raise GateError(f"snapshot not ok (ok={snap.get('ok')!r})")
    if snap.get("stale"):
        raise GateError("snapshot flags itself stale (stale=true)")
    updated = snap.get("updatedAt") or ""
    try:
        ts = datetime.fromisoformat(updated.replace("Z", "+00:00"))
    except Exception:
        raise GateError(f"snapshot updatedAt unparseable: {updated!r}")
    age = datetime.now(timezone.utc) - ts
    if age > timedelta(minutes=max_age_minutes):
        raise GateError(
            f"snapshot stale: updatedAt {updated} is {int(age.total_seconds() // 60)}m old "
            f"(limit {max_age_minutes}m)"
        )
    return snap


# ------------------------------------------------------------- journal ----

def _parse_at(raw):
    try:
        return datetime.fromisoformat(str(raw).replace("Z", "+00:00")).astimezone(ET)
    except Exception:
        return None


def load_journal_days():
    """Aggregate the Robinhood desk journal into per-ET-day facts.

    Returns {"YYYY-MM-DD": {cycles, reviewed, placed, live, symbols, reviews[]}}
    where reviews items are {time, symbol, side, dollars, reason, last, prev_close}.
    """
    if not JOURNAL_PATH.exists():
        raise GateError(f"desk journal missing: {JOURNAL_PATH}")
    days = {}
    for line in JOURNAL_PATH.read_text().splitlines():
        try:
            e = json.loads(line)
        except Exception:
            continue
        ts = _parse_at(e.get("at"))
        if ts is None:
            continue
        key = ts.strftime("%Y-%m-%d")
        day = days.setdefault(key, {
            "date": key, "cycles": 0, "reviewed": 0, "placed": 0,
            "live": False, "symbols": [], "reviews": [],
        })
        event = e.get("event")
        if event == "cycle":
            day["cycles"] += 1
            day["placed"] += int(e.get("placed") or 0)
            if e.get("live"):
                day["live"] = True
        elif event == "review" and e.get("symbol"):
            signal = e.get("signal") or {}
            quote = (((e.get("review") or {}).get("data")) or {}).get("quote_data") or {}
            day["reviewed"] += 1
            if e["symbol"] not in day["symbols"]:
                day["symbols"].append(e["symbol"])
            day["reviews"].append({
                "time": ts.strftime("%-I:%M %p ET"),
                "sort": ts.isoformat(),
                "symbol": e["symbol"],
                "side": signal.get("side") or (e.get("order") or {}).get("side") or "buy",
                "dollars": signal.get("dollar_amount")
                           or (e.get("order") or {}).get("dollar_amount") or "",
                "reason": signal.get("reason") or "",
                "last": quote.get("last_trade_price"),
                "prev_close": quote.get("previous_close"),
            })
    for day in days.values():
        day["reviews"].sort(key=lambda r: r["sort"])
    return days


def is_market_day(day_str):
    d = date.fromisoformat(day_str)
    return d.weekday() < 5 and day_str not in NYSE_HOLIDAYS


def fmt_display_date(day_str):
    d = date.fromisoformat(day_str)
    return d.strftime("%B %-d, %Y")


def fmt_weekday(day_str):
    return date.fromisoformat(day_str).strftime("%A")


# ----------------------------------------------------------------- html ----

def esc(value):
    return (str(value if value is not None else "")
            .replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
            .replace('"', "&quot;").replace("'", "&#39;"))


def base_css():
    """Daylight design language shared with the Bluechip funnel."""
    return """
    :root {
      color-scheme: light;
      --bg: #f8fafc; --ink: #0f172a; --muted: #475569; --soft: #64748b;
      --line: #e2e8f0; --card: #ffffff; --accent: #ea580c; --accent-dark: #c2410c;
      --blue-bg: #dbeafe; --blue-ink: #1e3a8a; --amber-bg: #fef3c7; --amber-hover: #fde68a;
      --amber-ink: #78350f; --emerald: #059669; --dark: #0f172a;
    }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
      background: var(--bg); color: var(--ink); line-height: 1.65; -webkit-font-smoothing: antialiased; }
    a { color: inherit; }
    .wrap { max-width: 72rem; margin: 0 auto; padding: 0 1.25rem; }
    .site-header { position: sticky; top: 0; z-index: 40; border-bottom: 1px solid var(--line);
      background: rgba(255,255,255,.92); backdrop-filter: blur(6px); }
    .nav { display: flex; align-items: center; justify-content: space-between; gap: 1rem; padding: .8rem 0; }
    .brand { display: inline-flex; align-items: center; gap: .65rem; text-decoration: none;
      font-weight: 700; letter-spacing: -.01em; font-size: 1.05rem; }
    .brand-mark { display: inline-flex; align-items: center; justify-content: center; width: 2.25rem;
      height: 2.25rem; border-radius: .75rem; background: var(--dark); color: #fff; font-size: .85rem; font-weight: 800; }
    .brand span.sub { color: var(--soft); font-weight: 400; }
    .nav-links { display: flex; flex-wrap: wrap; gap: 1rem; align-items: center; font-size: .9rem; color: var(--muted); }
    .nav-links a { text-decoration: none; }
    .nav-links a:hover { color: var(--accent); }
    .banner { display: block; background: var(--amber-bg); color: var(--amber-ink); text-align: center;
      padding: .65rem 1rem; font-size: .9rem; font-weight: 500; text-decoration: none; }
    .banner:hover { background: var(--amber-hover); }
    .hero { padding: 3.25rem 0 2.25rem; }
    .pill { display: inline-block; border-radius: 999px; background: var(--blue-bg); color: var(--blue-ink);
      padding: .3rem .85rem; font-size: .72rem; font-weight: 700; text-transform: uppercase; letter-spacing: .08em; }
    h1 { margin: 1rem 0 0; font-size: clamp(2rem, 5vw, 3rem); font-weight: 800; letter-spacing: -.02em; line-height: 1.1; }
    .lead { max-width: 46rem; margin: 1.1rem 0 0; color: var(--muted); font-size: 1.1rem; }
    .meta-row { display: flex; flex-wrap: wrap; gap: .6rem; margin-top: 1.25rem; color: var(--muted); font-size: .88rem; }
    .meta-chip { border: 1px solid var(--line); background: var(--card); border-radius: 999px; padding: .3rem .8rem; font-weight: 600; }
    .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(9.5rem, 1fr)); gap: .9rem; margin: 1.9rem 0 0; }
    .stat { background: var(--card); border: 1px solid var(--line); border-radius: 1rem; padding: 1rem 1.1rem;
      box-shadow: 0 1px 2px rgba(15,23,42,.04); }
    .stat b { display: block; font-size: 1.7rem; letter-spacing: -.02em; }
    .stat span { color: var(--soft); font-size: .8rem; font-weight: 600; text-transform: uppercase; letter-spacing: .06em; }
    .section { padding: 2.1rem 0; }
    .eyebrow { margin: 0 0 .8rem; color: var(--accent-dark); font-size: .74rem; font-weight: 800;
      text-transform: uppercase; letter-spacing: .12em; }
    h2 { font-size: 1.5rem; letter-spacing: -.01em; margin: 0 0 .8rem; }
    h3 { font-size: 1.1rem; margin: 1.4rem 0 .4rem; }
    p { margin: .7rem 0; }
    .card { background: var(--card); border: 1px solid var(--line); border-radius: 1rem; padding: 1.4rem;
      box-shadow: 0 1px 2px rgba(15,23,42,.04); }
    .card p { color: var(--muted); }
    .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(17rem, 1fr)); gap: 1rem; }
    a.card { display: flex; flex-direction: column; text-decoration: none; }
    a.card:hover { border-color: #fdba74; box-shadow: 0 10px 24px rgba(15,23,42,.08); }
    a.card .kicker { color: var(--accent-dark); font-size: .7rem; font-weight: 800; text-transform: uppercase;
      letter-spacing: .1em; margin-bottom: .6rem; }
    a.card h3 { margin: 0; font-size: 1.05rem; line-height: 1.35; }
    a.card .read { margin-top: auto; padding-top: .9rem; color: var(--accent-dark); font-weight: 700; font-size: .9rem; }
    .tapepanel { background: var(--dark); border-radius: 1.5rem; padding: 1.5rem; color: #e2e8f0;
      box-shadow: 0 18px 40px rgba(15,23,42,.18); }
    .tapepanel .panel-head { display: flex; justify-content: space-between; align-items: center; gap: 1rem;
      border-bottom: 1px solid #334155; padding-bottom: .8rem; margin-bottom: .4rem; }
    .tapepanel .panel-title { font-size: .72rem; font-weight: 700; text-transform: uppercase;
      letter-spacing: .1em; color: #94a3b8; }
    .livechip { display: inline-flex; align-items: center; gap: .45rem; border-radius: 999px;
      background: rgba(16,185,129,.15); color: #34d399; padding: .3rem .75rem; font-size: .68rem;
      font-weight: 700; text-transform: uppercase; letter-spacing: .08em; }
    .livechip i { width: .45rem; height: .45rem; border-radius: 999px; background: #34d399; }
    .tapeline { display: flex; gap: 1rem; padding: .7rem 0; border-bottom: 1px solid rgba(51,65,85,.6);
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .84rem; line-height: 1.55; }
    .tapeline:last-child { border-bottom: 0; }
    .tapeline .t { color: #64748b; white-space: nowrap; }
    .tapeline .sym { color: #fbbf24; font-weight: 700; }
    .shortanswer { border-left: 4px solid var(--accent); background: #fff7ed; border-radius: 1rem;
      padding: 1.1rem 1.3rem; margin: 1.6rem 0 0; font-size: 1.08rem; }
    .shortanswer .label { display: block; color: var(--accent-dark); font-size: .72rem; font-weight: 800;
      text-transform: uppercase; letter-spacing: .12em; margin-bottom: .35rem; }
    ul { padding-left: 1.25rem; }
    li { margin: .4rem 0; color: var(--muted); }
    .btn { display: inline-flex; align-items: center; gap: .5rem; border-radius: 999px; background: var(--accent);
      color: #fff; padding: .75rem 1.4rem; font-weight: 700; text-decoration: none; font-size: .95rem; }
    .btn:hover { background: var(--accent-dark); }
    .btn.ghost { background: var(--card); color: var(--ink); border: 1px solid var(--line); }
    .btn.ghost:hover { background: var(--bg); }
    .btnrow { display: flex; flex-wrap: wrap; gap: .8rem; margin-top: 1.4rem; }
    .faq details { background: var(--card); border: 1px solid var(--line); border-radius: 1rem;
      padding: 1rem 1.2rem; margin: .7rem 0; }
    .faq summary { cursor: pointer; font-weight: 700; }
    .faq p { color: var(--muted); margin-bottom: .2rem; }
    .sources ul { list-style: none; padding: 0; }
    .sources li { margin: .55rem 0; }
    .sources a { color: var(--blue-ink); font-weight: 600; }
    .disclaimer { border: 1px solid var(--line); background: var(--card); border-radius: 1rem;
      padding: 1.1rem 1.3rem; color: var(--soft); font-size: .82rem; line-height: 1.6; margin: 2.2rem 0; }
    .pagenav { display: flex; flex-wrap: wrap; gap: .8rem; margin-top: 1.8rem; }
    footer.site-footer { border-top: 1px solid var(--line); margin-top: 2rem; padding: 2rem 0 2.6rem;
      color: var(--soft); font-size: .85rem; }
    .footer-inner { display: flex; flex-wrap: wrap; gap: 1rem; justify-content: space-between; }
    footer.site-footer a { color: var(--muted); }
    @media (max-width: 700px) {
      .nav { flex-direction: column; align-items: flex-start; gap: .4rem; }
      .tapeline { flex-direction: column; gap: .1rem; }
    }
    """


def render_header(active=""):
    def link(href, label, key):
        style = ' style="color:var(--ink);font-weight:700"' if key == active else ""
        return f'<a href="{href}"{style}>{label}</a>'
    return f"""
    <header class="site-header">
      <div class="wrap nav">
        <a class="brand" href="/">
          <span class="brand-mark">DT</span>
          <span>DayTradingBot <span class="sub">· by EB28</span></span>
        </a>
        <nav class="nav-links" aria-label="Primary">
          {link("/fundmanager/", "Live tape", "fundmanager")}
          {link("/tape/", "Daily archive", "tape")}
          {link("/weekly/", "Weekly", "weekly")}
          {link("/answers/", "Answers", "answers")}
          {link("/bluechip/", "Bluechip", "bluechip")}
        </nav>
      </div>
    </header>
    <a class="banner" href="/fundmanager/">📡 The tape is live right now — watch the desk work before you believe a word we say →</a>
    """


def render_footer():
    year = datetime.now(ET).year
    return f"""
    <footer class="site-footer">
      <div class="wrap footer-inner">
        <span>© {year} EB28 · DayTradingBot.net · Every number on this page comes from our own desk journal and public tape.</span>
        <span><a href="/fundmanager/">Live tape</a> · <a href="/tape/">Daily archive</a> ·
          <a href="/weekly/">Weekly</a> · <a href="/answers/">Answers</a> ·
          <a href="https://eb28.co/blog/">EB28 blog</a> · <a href="/sitemap.xml">Sitemap</a></span>
      </div>
    </footer>
    """


def render_disclaimer():
    return f'<div class="wrap"><div class="disclaimer">{DISCLAIMER_HTML}</div></div>'


def page_shell(*, title, description, canonical, body, structured_data=None, active=""):
    jsonld = ""
    if structured_data:
        payload = json.dumps(structured_data).replace("<", "\\u003c")
        jsonld = f'<script type="application/ld+json">{payload}</script>'
    return f"""<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>{esc(title)}</title>
  <meta name="description" content="{esc(description)}" />
  <meta name="robots" content="index, follow, max-image-preview:large, max-snippet:-1" />
  <link rel="canonical" href="{esc(canonical)}" />
  <meta property="og:locale" content="en_US" />
  <meta property="og:site_name" content="DayTradingBot.net" />
  <meta property="og:type" content="article" />
  <meta property="og:title" content="{esc(title)}" />
  <meta property="og:description" content="{esc(description)}" />
  <meta property="og:url" content="{esc(canonical)}" />
  <meta name="twitter:card" content="summary" />
  <link rel="icon" href="/favicon.svg" />
  <style>{base_css()}</style>
  {jsonld}
  <script>(function(){{fetch('/analytics-config.json',{{cache:'no-store'}}).then(function(r){{return r.ok?r.json():null;}}).then(function(cfg){{var id=cfg&&String(cfg.ga4MeasurementId||'').trim();if(!id)return;var s=document.createElement('script');s.async=true;s.src='https://www.googletagmanager.com/gtag/js?id='+encodeURIComponent(id);document.head.appendChild(s);window.dataLayer=window.dataLayer||[];function gtag(){{window.dataLayer.push(arguments);}}window.gtag=gtag;gtag('js',new Date());gtag('config',id);}}).catch(function(){{}});}})();</script>
</head>
<body>
{render_header(active)}
<main>
{body}
</main>
{render_disclaimer()}
{render_footer()}
</body>
</html>
"""


# -------------------------------------------------------------- sitemap ----

def update_sitemap(new_urls):
    """Merge (loc, lastmod) pairs into sitemap.xml, preserving existing."""
    import re as _re
    sitemap_path = DOCS / "sitemap.xml"
    existing = sitemap_path.read_text() if sitemap_path.exists() else ""
    urls, seen = [], set()

    def add(loc, lastmod=""):
        if not loc or loc in seen:
            return
        seen.add(loc)
        urls.append((loc, lastmod))

    lastmods = dict(new_urls)
    for m in _re.finditer(r"<url>\s*<loc>([\s\S]*?)</loc>(?:\s*<lastmod>([\s\S]*?)</lastmod>)?", existing):
        loc = m.group(1).strip()
        add(loc, lastmods.get(loc, (m.group(2) or "").strip()))
    for loc, lastmod in new_urls:
        add(loc, lastmod)

    parts = ['<?xml version="1.0" encoding="UTF-8"?>',
             '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">']
    for loc, lastmod in urls:
        parts.append("  <url>")
        parts.append(f"    <loc>{esc(loc)}</loc>")
        if lastmod:
            parts.append(f"    <lastmod>{esc(lastmod)}</lastmod>")
        parts.append("  </url>")
    parts.append("</urlset>")
    sitemap_path.write_text("\n".join(parts) + "\n")


# ------------------------------------------------------------------ git ----

def _git(args, check=True):
    proc = subprocess.run(["git", *args], cwd=REPO, capture_output=True, text=True, timeout=180)
    if check and proc.returncode != 0:
        raise GateError(f"git {' '.join(args)} failed:\n{proc.stderr.strip()}")
    return proc


def git_publish(paths, message, push=True):
    """Stage ONLY the given paths, commit, push to main. Fail closed on errors.

    Returns True if a commit was created, False if there was nothing to commit.
    """
    rel = [str(p) for p in paths]
    _git(["add", "-f", "--", *rel])
    staged = _git(["diff", "--cached", "--name-only"]).stdout.strip()
    if not staged:
        print("[git] nothing to commit")
        return False
    _git(["commit", "-m", message])
    print(f"[git] committed: {message}")
    if not push:
        print("[git] push skipped (--no-push)")
        return True
    pushed = _git(["push", "origin", "HEAD:main"], check=False)
    if pushed.returncode != 0:
        print("[git] push rejected, rebasing on origin/main…")
        _git(["pull", "--rebase", "--autostash", "origin", "main"])
        _git(["push", "origin", "HEAD:main"])
    print("[git] pushed to main")
    return True
