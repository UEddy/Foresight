# Nivaria — project conventions for Claude Code

Nivaria is a competitive-intelligence app for SaaS sales teams (Node/Express
backend, vanilla-JS SPA under `public/`, sql.js database, Anthropic API for
analysis/outreach, Lemon Squeezy billing).

## Punctuation: no em-dashes, en-dashes, or connector-plus in user-facing output

**User-facing output may never contain an em-dash (`—`, U+2014), an en-dash
(`–`, U+2013), or a `+` used as a prose connector between words/phrases
("pricing + packaging").** This is a hard rule. It applies to:

1. All UI copy, labels, tooltips, modals, empty states, and error messages.
2. All landing-page and marketing copy.
3. All email templates.
4. All AI-generated content. Every prompt sent to the Anthropic API (brief
   generation, outreach playbooks, briefing condenser, severity analysis) must
   include an explicit instruction that the model never uses em-dashes,
   en-dashes, or `+` as a connector between words/phrases (write "and" instead).
5. All copy that Claude Code writes in any future commit.

Replace a dash with a **period, comma, colon, or parentheses** depending on
context (`", "` is the safe programmatic default). Replace a connector-plus with
**" and "**.

**What is NOT affected:**
- Ordinary hyphens (`-`) in compound words ("pre-meeting", "anti-bot",
  "win/loss"). Only the em-dash and en-dash characters are forbidden.
- `+` attached to digits/currency/versions ("$20+", "10+ competitors",
  "v2.1+"), or inside a product/plan name with no surrounding spaces
  ("Copilot+", "Plus+"). The connector rule only fires when `+` has whitespace
  on both sides between word characters. A `+` may also be reproduced when
  quoting a competitor's literal product/plan/pricing string exactly.
- Established UI labels that use an ampersand ("Slack & Discord") are fine.

### Enforcement (two layers)

1. **This document** — every session inherits the rule from `CLAUDE.md`.
2. **A runtime post-processor** — `src/lib/sanitizeText.js` exports
   `stripDashes(str)`, `stripPlusConnectors(str)`, `sanitizeCopy(str)` (both),
   and `sanitizeCopyDeep(obj)` (both, recursive over an object's strings).
   Before any AI-generated text is stored or displayed it is run through one of
   these, because LLM output is stylistically sticky and prompt instructions
   alone occasionally fail. Current wiring:
   - `src/analyzer.js` — `sanitizeCopyDeep` over the parsed brief in
     `tryParseAnalysis`, before the analysis is returned/persisted.
   - `src/playbooks.js` — `stripDashes` + `stripPlusConnectors` inside
     `applyVoiceFilters` on every generated outreach subject/body (local copies
     kept in sync with the canonical `" and "` replacement).
   - `src/briefingDispatch.js` — `sanitizeCopy` over each condensed pre-meeting
     talking point.
   - `src/outbound/sizeGate.js` — `sanitizeCopy` over the buyer-size estimate's
     model-written fields (`last_round`, `basis`, the employee band) in
     `normalizeEstimate`, and over the assembled size line in
     `formatSizeEstimate`, because both render on the lead row.
   - `src/routes/legal.js` — `stripDashes` over the rendered legal article HTML
     (the source docs are third-party boilerplate we extract verbatim).

   When you add a new AI call site or a new surface that renders model output,
   wire the same post-processor and add the no-dash / no-connector-plus
   instruction to its prompt.
