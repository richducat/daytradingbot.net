# Option 3 design QA

## Compared

- Selected design: `output/design-targets/daytradingbot-option-3-selected.png`
- Same-size implementation: `output/option3-implementation/watch-1487x1058-top.png`
- Combined comparison: `output/option3-implementation/reference-vs-implementation.png`
- Controlled Practice-state implementation:
  `output/option3-implementation/watch-1487x1058-practice-fixture.png`
- Ready-state comparison:
  `output/option3-implementation/reference-vs-practice-fixture.png`
- Default app window: `output/option3-implementation/watch-1180x760.png`
- Minimum app window: `output/option3-implementation/watch-900x640.png`
- Compact layouts: `output/option3-implementation/watch-720x740.png` and
  `output/option3-implementation/watch-390x844.png`

The selected design and both implementation states were compared together at
1,487 by 1,058 pixels. The ordinary browser preview intentionally shows the
fail-closed unavailable state because it has no Tauri backend. A separate
controlled Practice-state capture proves the selected ready-state layout using
read-only mock responses for the same commands exercised by rendered tests.
That temporary fixture hard-blocked every non-read command and was removed
after the screenshot; it is visual evidence, not a claim about a real account.

## Final comparison

- Typography: passed. The headline, body, navigation, controls, and supporting
  copy preserve the selected hierarchy. Visible supporting text is at least
  14px and ordinary body copy is 16px.
- Layout and spacing: passed. The sidebar, overview strip, 66/33
  chart-and-decision workspace, workflow explanation, and recent outcomes keep
  the selected reading order and density.
- Color and surfaces: passed. The dark neutral palette and restrained lime
  accent match the target. No gradients, decorative blobs, or generic glow
  effects were added.
- Assets and icons: passed. The interface uses the project-owned raster DTB
  mark, Tabler icons, and the real TradingView chart. It does not use inline
  SVG art, emoji, CSS chart art, or placeholder imagery.
- Copy: passed. Technical phrases found during the first comparison were
  replaced with plain customer language. The unavailable state now has a
  working, read-only **Check again** action.
- States and interactions: passed. Main navigation, onboarding, account retry,
  chart symbol selection, Follow Bluechip, Practice/Real history filters, and
  status retry are implemented. Unknown engine, bot, account, activity,
  catalog, and activation states fail closed instead of becoming false
  readiness or empty-history claims. Live workflow phases are never invented.
- Accessibility: passed. Semantic headings and regions, dialog labeling and
  focus containment, Escape closing and focus restoration, keyboard focus
  styles, selected-state semantics, reduced-motion support, 44px or larger
  primary controls, and an accessible text/table chart alternative are present.
- Responsiveness: passed. The 1,180 by 760 default and 900 by 640 minimum
  windows have no horizontal overflow. The 720px and 390px compact layouts also
  have no horizontal overflow; they move navigation into a labeled two-row
  header, stack the workspace, and preserve usable controls.

## Resolved findings

- P2: The unavailable-state action was disabled and left the customer with no
  recovery path. Fixed with a read-only **Check again** action and a clear
  result message.
- P2: “readback” and “Guide, not live stages” sounded like internal system
  language. Replaced with direct customer-facing language.
- P2: A styled-text brand square would have been a fake asset. Replaced with a
  project-owned raster brand mark.
- P0: Start or review could remain available when bot or account status was
  unknown. Fixed with engine-and-watch readback gating, funded Real-account
  readiness, and unavailable-state recovery actions that are read-only.
- P0: A shared busy state could make Pause unavailable while Real trading was
  active. Fixed with an independent, engine-authoritative Pause path in the
  main interface and every blocking dialog.
- P0: Trading secrets could remain visible or retained after a failed save.
  Fixed with masked entry and unconditional secret clearing.
- P1: Activity, catalog, activation, and provider readback failures could be
  presented as empty, unactivated, or borrowed from another provider. Fixed
  with explicit lifecycle states and provider-specific mapping.
- P1: Recorded outcomes could be labeled from an activity kind instead of the
  broker-recorded order state. Fixed by making the recorded state authoritative.
- P2: The 24-hour Real authorization did not state its two-day maximum. Fixed
  by disclosing the exact maximum for the full authorization window.
- P2: Coverage was helper-only. Added six rendered interaction tests, bringing
  the desktop suite to 35 passing tests.
- P0: A Real start could finish after the customer dismissed its confirmation,
  making Back or Escape look like cancellation. Fixed by locking every dialog
  dismissal path while Real or Practice start is awaiting its authoritative
  result.
- P0: Pause could disappear when the engine readback failed even though the
  watch readback still confirmed an active session. Fixed by treating either
  available running readback as reason to keep Pause visible, while requiring
  both readbacks to agree before Start.
- P1: Account-key and activation requests could finish after their dialogs were
  dismissed. Fixed with dedicated pending states, duplicate suppression, clear
  waiting copy, and disabled Close, Cancel, and Escape until completion.
- P1: Connected but unfunded accounts could say Ready. Fixed with explicit
  “Connected · funding needed” language everywhere.
- P2: Polymarket’s API-key workflow was labeled as a wallet connection. Fixed
  with the exact “Add API key” action.
- P2: Compact navigation hid every visible label. Fixed with visible 14px
  labels and 44px or larger controls at 720px and 390px.
- P2: The TradingView toolbar was denser than the selected design. The top
  toolbar is now hidden while the real chart, date-range controls, attribution,
  delayed-data notice, and display-only boundary remain.
- P2: Ready-state fidelity was unproven. Added the same-size controlled
  Practice-state comparison listed above.
- P2: Superseded captures were removed. Only the current evidence files listed
  above remain.
- P2: Added nine more rendered and helper regressions for the second-pass
  safety findings, bringing the desktop suite to 44 passing tests.

Independent frozen-source audit passed with P0 0, P1 0, and P2 0.

## Installed owner app verification

- Installed capture:
  `output/option3-implementation/installed-owner-app-paused.png`
- The signed owner build is installed at
  `/Applications/DayTradingBot Owner Demo.app`.
- The installed app reports **App activated**, **Connection verified**,
  **Practice · no real money**, and **Starts when you do**. Its primary action
  is **Start Practice**, proving no session was started during verification.
- The app and private owner DMG satisfy their Apple code-signing requirements
  for `net.daytradingbot.desktop.owner-demo` and
  `Apple Development: Richard Ducat (8693ZX8668)`.

final result: passed
