-- The checkout scheduler could not see the restaurant's hours, because nothing sent them.
--
-- The picker was <input type="datetime-local" min=now+15m max=now+14d> — a free-form clock
-- with no idea the branch exists. A diner could choose 3am on a day the branch is shut,
-- fill in address, phone and email, press Place order, and only then be told
-- 'branch_closed_at_scheduled_time' by place-order. The rejection is correct and arrives at
-- the worst possible moment.
--
-- storefront_status is already the one call the storefront makes for this kind of thing, so
-- the hours ride along with it rather than adding a second round-trip:
--
--   timezone            slots must be built in the STORE's zone, not the phone's. A diner
--                       in California ordering from a Texas branch otherwise sees windows
--                       shifted two hours.
--   opening_hours       branch_hours, the same rows is_branch_open() checks, so the picker
--                       and the server agree by construction instead of by coincidence.
--   scheduling_*        the per-branch policy that replaces place-order's hardcoded
--                       10-minutes-to-14-days. Defaults reproduce today's behaviour exactly.
create or replace function public.storefront_status(p_branch_id uuid)
returns jsonb
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
  select coalesce((
    select jsonb_build_object(
      'entitled',           coalesce(b.entitled_through is not null and b.entitled_through > now(), false),
      'delivery',           coalesce(b.entitled_through > now()
                                     and (be.features -> 'delivery') = to_jsonb(true)
                                     and public.is_delivery_available(b.id), false),
      'delivery_entitled',  coalesce(b.entitled_through > now() and (be.features -> 'delivery') = to_jsonb(true), false),
      'delivery_available', public.is_delivery_available(b.id),
      'delivery_hours_on',  coalesce((b.settings->>'delivery_hours_enabled')::boolean, false),
      'delivery_mode',      coalesce(b.settings->>'delivery_mode', 'platform'),
      'delivery_windows',   coalesce((
                              select jsonb_agg(jsonb_build_object(
                                       'day_of_week', h.day_of_week,
                                       'opens_at', to_char(h.opens_at,'HH24:MI'),
                                       'closes_at', to_char(h.closes_at,'HH24:MI'))
                                     order by h.day_of_week, h.opens_at)
                              from public.branch_delivery_hours h where h.branch_id = b.id
                            ), '[]'::jsonb),
      'card_payment',       coalesce(b.entitled_through > now() and (be.features -> 'card_payment') = to_jsonb(true), false),

      'timezone',           coalesce(b.timezone, 'America/New_York'),
      -- Empty array means "no hours configured", which is_branch_open() treats as
      -- always-open. The client must read it the same way, so the distinction between
      -- "no hours" and "closed all week" is preserved rather than flattened to [].
      'opening_hours',      coalesce((
                              select jsonb_agg(jsonb_build_object(
                                       'day_of_week', h.day_of_week,
                                       'opens_at', to_char(h.opens_at,'HH24:MI'),
                                       'closes_at', to_char(h.closes_at,'HH24:MI'))
                                     order by h.day_of_week, h.opens_at)
                              from public.branch_hours h where h.branch_id = b.id
                            ), '[]'::jsonb),
      'scheduling_enabled', coalesce((b.settings->>'scheduling_enabled')::boolean, true),
      'schedule_min_lead_min', greatest(0, coalesce((b.settings->>'schedule_min_lead_min')::int, 15)),
      'schedule_max_days',     greatest(0, coalesce((b.settings->>'schedule_max_days')::int, 14)),
      'schedule_slot_minutes', greatest(5, coalesce((b.settings->>'schedule_slot_minutes')::int, 15))
    )
    from public.branches b
    left join public.billing_entitlements be on be.restaurant_id = b.restaurant_id
    where b.id = p_branch_id
  ), jsonb_build_object('entitled', false, 'delivery', false, 'delivery_entitled', false,
                        'delivery_available', false, 'delivery_hours_on', false,
                        'delivery_mode', 'platform', 'delivery_windows', '[]'::jsonb,
                        'card_payment', false,
                        'timezone', 'America/New_York', 'opening_hours', '[]'::jsonb,
                        'scheduling_enabled', false,
                        'schedule_min_lead_min', 15, 'schedule_max_days', 14,
                        'schedule_slot_minutes', 15));
$function$;

revoke execute on function public.storefront_status(uuid) from public;
grant execute on function public.storefront_status(uuid) to anon, authenticated;
