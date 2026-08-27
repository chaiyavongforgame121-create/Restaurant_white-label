-- The first cut blocked when ANY transfer payment was not completed. A rejected slip
-- followed by an accepted one leaves a 'failed' row behind for the audit trail, which
-- would then block the order for ever. The gate is "has this order been paid", not
-- "is every payment row clean".
create or replace function public.tg_block_unpaid_transfer_progress()
returns trigger language plpgsql security definer set search_path to 'public','pg_temp' as $$
begin
  if new.status = old.status then return new; end if;
  if new.status not in ('confirmed','preparing','ready','out_for_delivery','completed') then
    return new;
  end if;
  if exists (select 1 from public.payments p
              where p.order_id = new.id and p.method = 'transfer')
     and not exists (select 1 from public.payments p
                      where p.order_id = new.id and p.method = 'transfer'
                        and p.status = 'completed')
  then
    raise exception 'transfer_payment_not_approved' using errcode = 'P0001';
  end if;
  return new;
end $$;
