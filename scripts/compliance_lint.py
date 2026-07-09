#!/usr/bin/env python3
"""Compliance lint gate for all EB28 automated marketing content.

Blocks anything that smells like an income claim, a performance promise, or a
Robinhood affiliation claim before it can publish. Fail-closed: pipelines must
refuse to publish when this returns violations.

Usage:
  python3 compliance_lint.py <file>       # exit 1 + report if violations
  from compliance_lint import lint        # lint(text) -> list[str]
"""
import re
import sys

# Each entry: (human label, compiled pattern)
RULES = [
    ("income claim: 'make/making money'", re.compile(r"\bmak(e|ing)\s+(you\s+)?money\b", re.I)),
    ("income claim: profit promise", re.compile(r"\b(guarantee[ds]?|promis(e|ed|ing))\b.{0,40}\b(profit|return|gain|win)", re.I)),
    ("income claim: 'passive income'", re.compile(r"\bpassive\s+income\b", re.I)),
    ("income claim: 'beat the market'", re.compile(r"\bbeat(s|ing)?\s+the\s+market\b", re.I)),
    ("income claim: 'get rich'", re.compile(r"\bget\s+rich\b", re.I)),
    ("income claim: earnings framing", re.compile(r"\b(earn|earned|earning)s?\b.{0,30}\$\s?\d", re.I)),
    ("performance marketing: % returns", re.compile(r"\d+(\.\d+)?\s?%\s*(return|gain|profit|ROI|monthly|weekly|annual)", re.I)),
    ("performance marketing: dollar-gain headline", re.compile(r"(made|profit(ed)?|gained|turned)\s+\$\s?\d", re.I)),
    ("performance marketing: projected returns", re.compile(r"\b(project(ed|ion)s?|expect(ed)?)\b.{0,30}\b(return|profit|gain)s?\b", re.I)),
    ("affiliation claim: Robinhood partnership", re.compile(r"\b(partner(ed|ship)?|endorse[ds]?|sponsor(ed|ship)?|official\s+partner)\b.{0,30}\brobinhood\b|\brobinhood\b.{0,30}\b(partner(ed|ship)?|endorse[ds]?|sponsor(ed|ship)?)\b", re.I)),
    ("hype: 'money printer / money machine'", re.compile(r"\bmoney\s+(printer|machine)\b", re.I)),
    ("hype: 'risk[- ]free'", re.compile(r"\brisk[\s-]?free\b", re.I)),
    ("hype: 'can't lose / never lose'", re.compile(r"\b(can'?t|never|won'?t)\s+lose\b", re.I)),
    ("advice framing: 'you should buy/sell'", re.compile(r"\byou\s+should\s+(buy|sell|invest\s+in)\b", re.I)),
]

# Phrases that legitimately mention negatives/disclaimers — spare them.
ALLOWLIST = [
    re.compile(r"won'?t\s+promise", re.I),
    re.compile(r"(no|zero|never\s+mak(e|ing))\s+(income|profit)\s+(claims?|promises?)", re.I),
    re.compile(r"does\s+not\s+endorse\s+or\s+sponsor", re.I),
    re.compile(r"lose\s+(the\s+)?money", re.I),
]


def lint(text: str) -> list:
    violations = []
    for label, pattern in RULES:
        for m in pattern.finditer(text):
            span = text[max(0, m.start() - 40): m.end() + 40].replace("\n", " ")
            if any(a.search(span) for a in ALLOWLIST):
                continue
            violations.append(f"{label}: …{span.strip()}…")
    return violations


def main():
    if len(sys.argv) < 2:
        print("usage: compliance_lint.py <file>", file=sys.stderr)
        sys.exit(2)
    text = open(sys.argv[1], encoding="utf-8").read()
    violations = lint(text)
    if violations:
        print(f"BLOCKED — {len(violations)} compliance violation(s):")
        for v in violations:
            print("  ✗", v)
        sys.exit(1)
    print("clean")


if __name__ == "__main__":
    main()
