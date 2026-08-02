# Nivaria post-launch roadmap

This is the working roadmap from launch onward. It is deliberately honest:
time estimates are rough, prerequisites are spelled out, and several later
phases are explicitly conditional. They ship only if real customer demand
justifies the work. Phase numbers are sequential, but not all phases are
committed; see the status on each.

**Legend.** Status is one of `in progress`, `ahead of schedule`, `planned`, or
`conditional` (may never ship). Time estimates are engineering effort, not
calendar time, and assume a single developer. Numeric ranges (e.g. 0.5–1 day)
use an en dash and just mean "somewhere in this range".

---

## Launch sequence

The minimum work to take real payments from real customers. These are committed
and either in progress or already ahead of schedule.

### Phase 11: Legal & support surface
- **Status:** in progress
- **Scope:** Terms of Service, Privacy Policy, and a monitored support email.
  Required before collecting payment or personal data in production.
- **Estimate:** 0.5–1 day (mostly drafting and review, not engineering).
- **Prerequisites:** none.

### Phase 12: Production deployment
- **Status:** in progress
- **Scope:** Domain DNS configuration, Railway deployment behind HTTPS, and
  Resend domain verification so transactional email (OTP, briefings) sends from
  the production domain.
- **Estimate:** 1 day, plus DNS and verification propagation wait time outside
  our control.
- **Prerequisites:** Phase 11 (legal pages must be live at launch).

### Phase 13: End-to-end real customer test
- **Status:** ahead of schedule
- **Scope:** One real customer completes the full path: register, verify OTP,
  subscribe via Lemon Squeezy (live mode), receive a real brief. Flip
  `LEMONSQUEEZY_TEST_MODE=false` only after this passes in test mode end to end.
- **Estimate:** 0.5 day of active testing, plus monitoring the first live
  transaction.
- **Prerequisites:** Phase 12 (deployment live); Lemon Squeezy store activated
  (see deferred follow-ups below).

---

## Post-launch (planned)

Sequenced after launch. Order can change based on what early customers ask for.

### Phase 14: Performance optimization
- **Status:** planned
- **Scope:** Deferred from Phase J. Slow-3G First Contentful Paint is ~9.2s.
  Fix with JS/CSS bundling and minification, `font-display: swap`, and response
  compression (gzip/brotli). Target a meaningful FCP reduction on throttled
  connections.
- **Estimate:** 1–2 days.
- **Prerequisites:** none technically, but best done after launch so we
  optimize against real production assets and traffic.

### Phase 15: HubSpot CRM integration
- **Status:** planned (conditional on demand)
- **Scope:** Auto-import deal outcomes from HubSpot via OAuth, removing the
  manual and Slack logging steps for teams that live in a CRM.
- **Estimate:** 3–5 days (OAuth flow, field mapping, sync reliability, error
  handling).
- **Prerequisites:** none hard. This is the first CRM we'd build because HubSpot
  has the lowest-friction OAuth and developer onboarding.

#### Phase 15.5: Salesforce CRM integration
- **Status:** conditional
- **Scope:** Same auto-import, Salesforce edition.
- **Estimate:** 4–6 days (Salesforce OAuth and object model are heavier than
  HubSpot's).
- **Prerequisites:** Phase 15 shipped **and** validated with real user feedback.
  We deliberately do not build two CRM integrations on speculation. Salesforce
  only happens if HubSpot proves the demand and customers specifically ask for
  Salesforce.

### Phase 16: Team tier multi-user features
- **Status:** planned
- **Scope:** Workspace invitations, member roles (admin/member), and shared
  workspace resources. This is what actually unblocks the **Team tier waitlist**
  to convert into paid subscriptions. (Formerly tracked as Phase 10.5.)
- **Team definition (locked June 2026):** Cap: 60 competitors. Monitoring: twice
  daily. Waitlist members get 10% off first 2 months at launch (honor via Lemon
  Squeezy discount code). Enforcement built in this phase uses these constants.
- **Estimate:** 5–8 days for the feature set, **plus** the prerequisite below.
- **Prerequisites (hard):** Complete the `user_id` to `workspace_id` query
  refactor documented in [`phase-10.5-prerequisites.md`](phase-10.5-prerequisites.md).
  Estimated 2–3 hours on its own. This is non-optional: until reads are
  workspace-scoped, a non-owner member would not see workspace data created by
  the owner. It is the literal first task of this phase.

### Phase 17: Slack live verification & command rename
- **Status:** planned
- **Scope:** Verify the Slack integration end to end against a live workspace,
  and rename the slash command from `/foresight` to `/nivaria` on Slack's side
  (the old name predates the Nivaria rebrand). Includes updating the command
  registration, docs, and any user-facing copy.
- **Estimate:** 0.5–1 day.
- **Prerequisites:** Slack app reviewed and approved if distribution requires it;
  coordinate the rename so existing test installs aren't broken silently.

### Phase 18: Business tier infrastructure
- **Status:** conditional on demand
- **Scope:** Tier 4 ("fortress") capabilities: protected-site scraping
  infrastructure, hourly monitoring, API access and advanced webhooks, and
  12-month change history. Backs the **Business tier** ($999/mo) currently on the
  waitlist. The Business storefront bullet is "API access and advanced webhook
  delivery" (nothing bespoke is sold through the storefront).
- **Business definition (locked June 2026):** No advertised competitor cap. Copy:
  "entire competitive landscape". Internal soft ceiling at enforcement time
  (alert, not block, around 300) with outliers routed to enterprise contact.
  Fair-use covered by ToS. Hourly monitoring. Protected-site scraping. API access
  and advanced webhooks. 12-month history. Priority support. Same 10% waitlist
  discount as Team (honor via Lemon Squeezy discount code).
- **Estimate:** Not estimated yet. Scope depends heavily on what the first
  Business-tier prospect actually needs. Could be 2+ weeks.
- **Prerequisites:** Phase 16 (multi-user) for shared-team support; at least one
  serious Business-tier prospect. We will not build this speculatively.

### Phase 19+: Customer-driven priorities
- **Status:** intentionally unplanned
- **Scope:** Whatever paying customers tell us matters. We are deliberately not
  pre-planning beyond Phase 18. Roadmaps invented before product-market fit tend
  to be wrong; once there is real usage, feedback drives the queue.
- **Estimate:** N/A.
- **Prerequisites:** real customers and real feedback.

---

## Deferred follow-ups from Phase 10

Items consciously parked during Phase 10 (Lemon Squeezy billing). Tracked here
so they are not lost.

- **`user_id` to `workspace_id` refactor:**
  [`phase-10.5-prerequisites.md`](phase-10.5-prerequisites.md) documents the full
  audit (files, tables to convert, tables to leave alone). Now folded in as the
  **hard prerequisite for Phase 16**. ~2–3 hours.
- **Test 8 (Lemon Squeezy customer portal):** deferred pending store
  activation. The "Manage subscription" portal can only be exercised once the
  store is active; revisit during the Phase 13 live test.
- **`/foresight` to `/nivaria` Slack rename:** the slash command still uses the
  pre-rebrand name. Folded into **Phase 17**.

---

## What might never ship

Being explicit so the roadmap isn't read as a set of promises:

- **Phase 15.5 (Salesforce):** only if HubSpot proves CRM demand.
- **Phase 18 (Business tier):** only with a real Business-tier prospect.
- **Phase 19+:** undefined by design.

Everything through Phase 17 is intended to ship. Everything after is a candidate,
not a commitment.
