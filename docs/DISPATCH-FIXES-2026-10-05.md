# Rider dispatch fixes (owner requests 2026-10-05)

The owner reported, at Food Thai Thai:
1. Two riders (Bobby Chu, Peter Box) "banned" — lift it (done by hand the same day), and add a **Lift cooldown** button.
2. "Searching for a rider" takes very long and often ends in "No rider found — tap to retry".
3. When the offered rider rejects, the job must go straight to the next rider, then the next, until there is nobody left.
4. FavorGO must make a **sound** when an offer / job arrives.
5. Dispatching **two or more orders at the same time** misbehaves (stacked orders both stuck on "No rider found").

## 1. What is actually wrong (live forensics, 2026-10-05)

- **Nothing dispatches on the server.** `private.app_settings` is empty, so every database path that should call the
  `dispatch-driver` edge function over pg_net returns early: the ready trigger (`orders_after_ready_dispatch`),
  `reject_dispatch`, `private.expire_dispatch_offers` (cron every 30 s), `driver_cancel_delivery`,
  `requeue_failed_delivery`. `net._http_response` holds zero dispatch calls. Every offer made today came from a staff tap.
- **"Searching" is a client timer.** The kitchen card spins for 120 s after *ready* with nothing running
  (`kitchen-view.tsx` `SEARCH_TIMEOUT_SEC`), then shows "No rider found".
- **"Tap to retry" is `reset:true`**, which wipes `dispatch_history`, so the rider who just declined is ranked first again.
  Peter was offered the same order 3 times in a minute, Bobby twice; with the penalty rule (2 rejects or timeouts in
  24 h → 60-minute cooldown) that is exactly how both were "banned".
- **No retry when nobody is free.** A run with no candidates is never retried; a rider becoming free never pulls a
  waiting order.
- **`driver_max_attempts=3`** counts offers and empty runs alike, so a round stops after 3 tries, not when candidates run out.
- **Concurrency.** Choosing a rider and stamping the offer are separate calls with no lock. At 15:52:18 two runs 254 ms
  apart offered three orders (a stacked pair + a single) to Peter. A rider holding an un-accepted offer counts as busy,
  so the next order gets `no_drivers` and then waits forever.
- **Stacks.** A decline of a stacked offer is written into both stops' history and excludes that rider from both;
  retrying one stop resets only that stop, the pair re-forms with the other stop still carrying the rejection.
  Reset also overwrites an already **accepted** job (`index.ts:182`).
- **Riders get no push and no sound.** `notify_worker_url` is unset (worker cron no-ops), there are no VAPID secrets
  and no push subscriptions; 161 `notifications_outbox` rows are stuck `pending` (some from June). The app only calls
  `navigator.vibrate` (blocked before a tap on Android, absent on iPhone). The wake lock is held only during a delivery,
  so a waiting rider's screen locks and the realtime socket dies.
- **Nothing can lift a cooldown** (`drivers.cooldown_until`), and staff never see "rider on cooldown" as the reason.

## 2. Decisions

| # | Decision |
|---|---|
| D1 | **Dispatch runs in the database.** A new `private.dispatch_delivery(p_delivery_id uuid, p_mode text)` picks the rider and stamps the offer in one transaction. Triggers, `reject_dispatch`, the expiry sweep, `driver_cancel_delivery` and `requeue_failed_delivery` call it **directly** — no pg_net, no service-role key stored in the database. The `dispatch-driver` edge function becomes a thin authenticated wrapper over it with the same request and response shape, so the admin UIs keep working. Errors inside a trigger-driven dispatch are caught and logged so marking an order ready never fails because of dispatch. |
| D2 | **Rounds.** A round starts when the order is ready (or when staff start a new round). Within a round each rider is offered a delivery at most once: declined, expired and reassigned offers all exclude that rider for the rest of the round. On a reject or an expiry the next rider is offered **immediately**. When no un-asked eligible rider is left the round is *waiting*: a sweep (every 30 s, with the expiry cron) offers it to any rider who becomes eligible later (comes online, finishes a job, cooldown ends) — still never someone already asked in this round. After `dispatch_search_window_min` (branch setting, default 15) without an accepted rider the round ends as **no rider found**; staff can start a new round, in which everyone may be asked again. `driver_max_attempts` is no longer used. |
| D3 | **Fair penalties.** A rider gets at most one strike per delivery (a stack counts as one). A new round never strikes a rider again for the same order. |
| D4 | **Concurrency.** `dispatch_delivery` takes a per-branch advisory transaction lock, then locks the chosen rider's `drivers` row `FOR UPDATE SKIP LOCKED` and re-checks that the rider holds no open offer and no active job (another branch's dispatch may have offered first). Every status write is guarded so a concurrent run cannot flip an offered row back. |
| D5 | **Stacks.** A stack is dispatched and restarted as one unit: exclusions are the union of riders asked for either stop in the round; a staff restart resets both stops; a stacked decline is one strike at most and moves the stack to the next rider. |
| D6 | **Safe restart.** A staff restart is refused (`409 already_accepted`) once a rider has accepted. Restarting while an offer is open withdraws it without a strike. |
| D7 | **The boards show the server's truth.** Kitchen and Live deliveries show: *Offered to {rider} · {countdown}*, *Searching — asked {n} riders*, or *No rider found — {reason}* (every rider asked / riders on cooldown / nobody online / no fresh GPS / search window over) only when the server says so — no client timer. The button is **Find rider again** (a new round). |
| D8 | **Lift cooldown.** `public.lift_driver_cooldown(p_driver_id, p_branch_id, p_note)`: a platform admin, or staff with `drivers.manage` at **every** branch where the rider is not rejected (the same rule as KYC, because the cooldown is global). Clears the cooldown, the streak and the strike window; writes `audit_logs`. Button on the rider roster `/b/[branchId]/drivers` with a confirm. The rider app re-reads its row when it becomes visible. |
| D9 | **FavorGO sound.** A shared `packages/ui/src/lib/sound.ts` (the kitchen's Web Audio chime, moved; admin re-exports it). An offer rings an urgent repeating chime (about every 3 s) and vibrates until it is accepted, declined or expires; a new active job rings once. Audio is unlocked by any tap (Go online, tabs) and a "Tap to enable sound" strip shows while it is locked. While the rider is online the screen is kept awake (wake lock), so offers keep arriving; the rider can turn it off. A failed reject is shown, not hidden. |
| D10 | **Push, when the phone is locked** (needs the owner's VAPID setup, §4): the worker skips stale rows (an offer older than its expiry; anything else older than 30 minutes) instead of sending them, sends offers with `urgency: high` and a TTL equal to the offer's life, and the service worker tells an open app about a push and closes an offer's notification once it is gone. `notify_worker_url` (not a secret) is set in `private.app_settings` so the cron tick runs. |

## 3. Interfaces (the contract the builders share)

```sql
-- One dispatch step. Mode: 'auto' (triggers, sweeps, reject/expiry cascades), 'staff' (a staff "find rider":
-- continue the round), 'staff_restart' (a staff "find rider again": new round, both stops of a stack).
private.dispatch_delivery(p_delivery_id uuid, p_mode text default 'auto') returns jsonb
  -- {ok, result: 'offered'|'offered_batch'|'waiting'|'no_rider_found'|'already_accepted'|'not_dispatchable',
  --  driver_id?, delivery_ids?, batch_id?, offer_expires_at?, asked_count, diagnostics?{...counts, cooling_down,
  --  already_asked}, reason?}

-- Staff entry point used by the edge wrapper (or directly by the UI): checks delivery.manage or kitchen.access
-- at the delivery's branch for auth.uid(); p_restart maps to 'staff_restart'.
public.staff_dispatch_delivery(p_delivery_id uuid, p_restart boolean default false) returns jsonb

-- Sweep, called by the existing 30-second cron after expire_dispatch_offers.
private.dispatch_sweep() returns integer

public.lift_driver_cooldown(p_driver_id uuid, p_branch_id uuid, p_note text default null) returns timestamptz
```

`deliveries` gains `dispatch_round_started_at timestamptz` and `dispatch_state text` (`searching` | `waiting` |
`no_rider_found` | null) so the boards read the state instead of guessing; `dispatch_history` keeps the per-offer log
(`offered` / `rejected` / `offer_expired` / `withdrawn` / `waiting` / `no_rider_found`, each with the round start).
Branch setting `dispatch_search_window_min` (default 15). `list_branch_riders` returns `cooldown_until`.

## 4. What the owner does (push only)

Push to a locked phone needs VAPID keys: generate them (`node scripts/generate-vapid-keys.cjs`), set the Supabase
secrets `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`, and the Vercel env `NEXT_PUBLIC_VAPID_PUBLIC_KEY`
on `restaurant-white-label-driver`, then redeploy the driver app. Riders then tap "Turn on notifications" once
(iPhone: from the Home Screen app, iOS 16.4+). Sound while the app is open works without this.
