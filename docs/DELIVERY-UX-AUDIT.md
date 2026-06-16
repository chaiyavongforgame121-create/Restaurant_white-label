# Delivery UX Audit & Smoothness Plan — 2026-06-15

> Why does the app "feel hard to use", especially delivery? This is a tap-by-tap audit of the
> delivery flow across all four surfaces (customer web · driver app · merchant/kitchen admin ·
> backend), benchmarked against Uber Eats, DoorDash, Grab/GrabFood, foodpanda, Lineman and
> Deliveroo, with a prioritized fix list. Produced by a multi-agent audit (4 code-readers + 4
> competitor-research agents + synthesis) cross-checked against the live DB.
>
> **Companion build record:** `docs/DELIVERY-BUILD.md` (the original delivery-first build).

## TL;DR — three structural problems

1. **Payment is split and broken.** Tapping **"Place order ($X)"** with *Card* selected does **not**
   charge anything. The order is created `pending`, the cart cleared, and the user routed to the
   tracking page where a *separate* "Payment pending" card needs two more taps — and the real Stripe
   path (`order-tracking.tsx` `confirmStripe`) mounts no card Element and gives no success feedback,
   while the dev mock can hang on "Processing…" forever. Every leading app charges **before**
   confirming the order. *(P0, high effort, tied to the still-deferred payment-gateway decision.)*
2. **The delivery state machine diverged across roles.** Two driver stages were UI-only (never
   persisted), stage progression was an unguarded client `UPDATE` that could skip `picked_up`, the
   kitchen jumped `ready → completed` (skipping `out_for_delivery`), and the customer tracker reset
   to step 1 on `delivered`. *(Mostly fixed this session — see below.)*
3. **Almost no in-flight feedback on the critical path.** Accepting an offer didn't navigate the
   driver to the run; go-online / accept / stage-advance fired async with no loading or rollback;
   the customer never got "out for delivery" / "delivered" pushes (templates existed but nothing
   enqueued them). *(Largely fixed this session.)*

---

## How leading apps work (benchmark)

| Area | Uber Eats / DoorDash / Grab / foodpanda / Deliveroo | Favornoms (before) |
|---|---|---|
| **Payment** | Collect card / Apple-Google Pay **at checkout**, then confirm. Grab "one press = order". | Deferred to tracking page; Stripe confirm path non-functional. |
| **Dispatch timing** | Predict prep time, send courier to **arrive as food is ready** (not at order time). | Manual "Find driver" ghost button; can be skipped. |
| **Driver match** | Offer to the single best-ranked courier; 40+ factors, not just nearest. | Scored candidates ✅ (good). |
| **Offer TTL** | ~30–50s; timeout == decline; **immediate re-dispatch** down a ranked list. | 75s TTL ✅, but `reject` didn't re-dispatch at all (stranded). |
| **No driver found** | Keep retrying → batch into another run → auto-cancel + refund as last resort. | `dispatch_attempts` miscounted → premature "no driver" alert. |
| **Customer status** | Few coarse, **always-advancing** stages + proactive push at each step. | Bar reset on `delivered`; "on the way"/"delivered" pushes were dead code. |
| **After ordering** | Drop straight onto the live tracker; celebratory close on delivery. | Sometimes lands on /cart; driver card lingers. |
| **Driver accept** | Hands straight to the active run / turn-by-turn. | Stayed on home screen; manual Active-tab tap. |
| **Optimistic UI** | Instant feedback, rollback on the rare failure. | Mostly waited on the server; chat cleared text before send. |
| **Merchant throttle** | Busy → Pause → Closure, with auto-revert / tablet heartbeat. | All present ✅, but Hours save could wipe all rows → "always open". |

Key sources: DoorDash Engineering (dispatch optimization, order-ready-time), Uber Eats ML ETA &
Orders app, Grab allocation (40+ factors, auto-accept), foodpanda score-based scheduling & "assign
the rider who arrives as food is ready", Deliveroo "Frank" re-planning, Baymard food-delivery UX,
Nielsen Norman Group (system-status, response-time limits, error prevention, thumb zones).

---

## Per-surface friction (highlights)

### Customer (web — checkout + tracking)
- **CRITICAL** Card payment split/broken (see TL;DR #1). `order-tracking.tsx:366-392`.
- Status bar **regressed to step 1** when `order.status = 'delivered'` (`delivered` missing from the
  steps array). `order-tracking.tsx:15-21`. **Fixed.**
- Could submit a delivery order with a **free-typed, coordinate-less address** (flat $3.99 fallback,
  undeliverable order). `checkout-view.tsx:92`. **Fixed.**
- In-app chat: composer cleared **before** the send resolves; a failed send is lost silently; guests
  get no chat at all. `delivery-chat.tsx` / `chat-thread.tsx:49`. *(Open — P2.)*
- Live map silently disappears (no "map unavailable" state) when token/branch coords missing.
- Native `window.confirm`/`prompt` for cancel & edit-instructions. `order-actions.tsx:35,48`. **Fixed.**
- "View full receipt" used a fragile relative href. `order-tracking.tsx:233`. **Fixed.**

### Driver app
- Accepting an offer **didn't navigate to the active run**. `delivery-provider.tsx` / `home-view.tsx:188`. **Fixed.**
- Two of five stages ("at pickup", "arrived at customer") were **UI-only / never persisted**;
  `progressDelivery` was a raw `UPDATE` with no precondition (could skip `picked_up`).
  `active-view.tsx:30-67` / `driver.ts:147`. **Fixed** (guarded RPC + persist arriving).
- No loading/disabled on go-online / accept / advance → double-fire; online state read from a
  persisted store, never reconciled with `drivers.is_online`. Advance CTA double-fire **fixed**;
  go-online reconcile *(open — P3)*.
- Active-screen "map" is a **decorative animation**, not a live route. *(Open — P2.)*
- Today/Week earnings tiles were **hardcoded $0**. `home-view.tsx:98-103`. **Fixed.**
- No completion screen / earnings tally / next-order after delivery. *(Open — P2.)*
- Geolocation-denied swallowed silently. *(Open — P3.)*

### Merchant (admin / kitchen)
- **CRITICAL** HoursEditor save was non-atomic delete-then-insert → a failed insert wiped all hours,
  silently flipping the branch to "always open". `hours-editor.tsx:88-101`. **Fixed** (atomic RPC).
- Kitchen status writes were fire-and-forget (no rollback); delivery orders skipped
  `out_for_delivery` (`ready → completed`). `kitchen-view.tsx:273,330`. *(Partly open — see #8 below.)*
- `OrderRowActions` gated refund/cancel on **misspelled** statuses (`canceled`/`delivered`) so
  terminal orders still showed dead actions. `order-row-actions.tsx:22-23`. **Fixed.**
- Native `prompt`/`confirm`/`alert` for notes, cancel, tax invoice, and the kitchen 86 flow. **Fixed.**
- Dispatch result auto-clears after 4s; failed deliveries strand staff (action only on Orders page).

### Backend (dispatch state machine)
- **"Out for delivery" / "Delivered" customer pushes were dead code** — templates existed in
  notify-worker but no trigger enqueued them. **Fixed.**
- `progressDelivery` bypassed the guarded-RPC pattern (state-machine hole). **Fixed.**
- `reject_dispatch` miscounted `dispatch_attempts` (history length, not rounds) → premature
  "no driver found". Also it **never re-dispatched** after a reject (stranded the delivery).
  **Both fixed.**
- Earnings derive from `distance_km`, null on un-geocoded addresses → silent base-pay-only offer.
  *(Mitigated by the checkout address-gate; defense-in-depth open — P2.)*
- Offers are push-only with no SMS/in-app fallback. *(Open.)*
- Edge-function deployment drift: `place-order` v8 live vs v9 in repo. *(Open — deploy task.)*

---

## Prioritized recommendations

| # | Fix | Area | Impact/Effort | Priority | Status (2026-06-15) |
|---|---|---|---|---|---|
| 1 | Collect payment before confirming (Stripe-in-checkout + wallets) | customer | H / H | **P0** | Open (payment decision) |
| 2 | Status-bar: alias `delivered`→`completed` | customer | H / L | **P0** | ✅ Done |
| 3 | Persist soft stages + guarded `progress_delivery` RPC | driver/backend | H / M | **P0** | ✅ Done |
| 4 | Auto-navigate driver to active run on accept | driver | H / L | **P0** | ✅ Done |
| 5 | Wire "out for delivery" + "delivered" pushes (+ real ETA) | backend | H / L | **P0** | ✅ Done |
| 6 | Loading/disabled/rollback on every critical async action | cross | H / M | P1 | Partial (advance CTA done) |
| 7 | Block delivery checkout until address resolves to coords | customer | H / L | P1 | ✅ Done |
| 8 | Auto-dispatch on ready; never complete a delivery without a driver | merchant | H / M | P1 | Open |
| 9 | Atomic HoursEditor save | merchant | M / L | P1 | ✅ Done |
| 10 | Optimistic chat echo + retry; guest chat path | cross | M / M | P2 | Open |
| 11 | Real live route map on driver active screen | driver | M / M | P2 | Open |
| 12 | Driver completion screen + earnings + next order | driver | M / M | P2 | Partial (tiles wired) |
| 13 | Fix `dispatch_attempts` counting (+ re-dispatch on reject) | backend | M / L | P2 | ✅ Done |
| 14 | Don't underpay drivers when `distance_km` null | backend | M / L | P2 | Mitigated |
| 15 | Replace native confirm/prompt/alert with styled UI | cross | M / L | P2 | ✅ Done |
| 16 | Receipt link / peak-bonus label / geo-denied banner | mixed | L / L | P3 | Receipt ✅; rest open |

---

## Changes applied this session (2026-06-15)

### Database (Supabase project `ayyfczidnzxetndiijmv`, via MCP `apply_migration`)
- `fix_loyalty_tier_recompute_cast_and_resilient_cron` — **the cron bug.**
  `recompute_loyalty_tiers()` compared enum `loyalty_tier` with `text` (no operator) so
  `daily-loyalty-housekeeping` failed **19/19 runs** since 2026-05-28, which also blocked
  `issue_birthday_rewards()` (second statement in the same job → **birthday rewards never issued**).
  Fix: cast `::loyalty_tier`; new resilient wrapper `private.run_loyalty_housekeeping()` runs each
  step in its own block; cron re-pointed at the wrapper.
- `wire_out_for_delivery_and_delivered_customer_pushes` — `tg_deliveries_customer_notifications`
  now enqueues `order_out_for_delivery` (on `picked_up`) and `order_delivered` (on `delivered`);
  `driver_assigned` ETA falls back to `estimated_duration_min` (was null `current_eta_min` → "30 min").
- `atomic_set_branch_hours` — `set_branch_hours(p_branch_id, p_windows)` (SECURITY INVOKER, RLS
  preserved) replaces delete-then-insert atomically.
- `guarded_progress_delivery_state_machine` — `progress_delivery(p_delivery_id, p_next)` validates
  `assigned → picked_up → in_transit → delivered` (no skips, requires acceptance, idempotent,
  stamps timestamps); `mark_delivery_arriving(p_delivery_id)` persists "arrived" (sets `arriving_at`).
- `reject_dispatch_fix_attempts_and_redispatch` — stop inflating `dispatch_attempts`; **re-dispatch**
  to the next-best driver after a reject (previously a declined offer stranded the delivery).

### Code
- `apps/web/.../order-tracking.tsx` — status alias `delivered→completed`; receipt link via `usePathname`.
- `apps/web/.../checkout-view.tsx` — gate "Place order" on resolved coords; "Calculating delivery…" state.
- `apps/web/.../order-actions.tsx` — inline cancel-confirm + notes editor (no native dialogs).
- `apps/driver/.../home-view.tsx` — `router.push('/app/active')` on accept; real today/week earnings.
- `apps/driver/.../active-view.tsx` — advance CTA `loading/disabled` (double-fire guard); persist "arrived".
- `apps/driver/.../delivery-provider.tsx` — `accept()` returns success; `markArriving()` added.
- `packages/database/src/queries/driver.ts` — `progressDelivery` → guarded RPC; `markDeliveryArriving`.
- `apps/admin/.../hours-editor.tsx` — atomic `set_branch_hours` RPC.
- `apps/admin/.../order-row-actions.tsx` — styled cancel/notes/invoice modals; fixed status-string bug.
- `apps/admin/.../kitchen-view.tsx` — 86 flow uses a styled confirm modal (no `window.confirm/alert`).

Verified: `pnpm -r type-check` green (7 projects).

---

## Update — P1 + P2 + extras shipped (2026-06-15, round 2)

Payment (P0) intentionally deferred. Everything else in P1/P2 was built to make the flow feel like
a complete consumer delivery app (still white-label). `pnpm -r type-check` + `build` green.

**Driver (P1/P2):** online toggle now optimistic-with-rollback + reconciles from `drivers.is_online`
on mount + is locked during an active delivery (can't accidentally go offline mid-run); Accept/Reject
have a busy guard; the decorative SVG map is replaced by a **real `DeliveryMap`** (live GPS puck +
branch/dropoff + route, graceful fallback); a **delivery-complete screen** shows the credited earnings
(incl. peak bonus, refetched) + "find next order"; geolocation-denied banner.

**Merchant (P1):** kitchen delivery orders no longer bump `ready → completed` — `ready` is the last
kitchen step and the card shows the **live rider status** (finding/offered/assigned) via a deliveries
realtime subscription; `updateStatus` rolls back the optimistic lane on write error; the live-ops board
gained a **Re-dispatch** action for failed deliveries.

**Customer (P2):** in-app chat is now **optimistic** (instant bubble, "tap to retry" on failure, no
lost text) via `ChatThread`; guests get an explained Chat affordance instead of a silent gap; checkout
no longer traps a saved address that lacks coordinates.

**DB migrations (round 2):** `reject_dispatch_accept_guard_and_push_dedup` — reject is a no-op once the
offer is accepted (closes an accept↔timeout race, with a client `busyRef` guard too); `out_for_delivery`
push dedups against requeue/re-pickup.

**Adversarial review:** a 10-agent cloud review of the round-2 diff surfaced 6 findings; **5 confirmed
real and all fixed** (progress() swallowed the guarded-RPC error → false "complete" screen; power
toggle offline mid-delivery; accept/timeout race; saved-address checkout trap; duplicate push). 1
refuted (a cosmetic `new_dispatch` email string, in the un-deployed notify-worker).

## Still open (recommended next)

- **P0 — payment redesign (#1):** mount Stripe Payment Element / Apple-Pay-Google-Pay in checkout,
  charge before confirm, retire the deferred tracking-page payment + browser-side mock writes.
  Blocked on the payment-gateway decision (still user-deferred).
- **Offers push fallback:** dispatch offer is push-only; an offline driver app misses it until the
  realtime/TTL. Add SMS/in-app fallback (needs Twilio).
- **Ops:** deploy `place-order` v9 to close the v8 drift; deploy any notify-worker copy tweaks.
- **Polish:** stale-realtime/“last updated” cue on customer tracking; map-unavailable cue on the
  customer hero (the map already degrades gracefully).
