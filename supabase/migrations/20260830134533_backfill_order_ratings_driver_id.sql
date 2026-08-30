-- order_ratings.driver_id was never written by the customer app: the insert listed
-- order_id, customer_id, branch_id, food_stars, delivery_stars and comment, and nothing
-- else. So every delivery star ever given attached to no rider, and drivers.average_rating
-- had nothing to aggregate even after the sync trigger was added.
--
-- The client now sets it. This recovers the history, taking the rider from the order's own
-- delivery — which is the only rider it could ever have meant.
update public.order_ratings r
   set driver_id = d.driver_id
  from public.deliveries d
 where d.order_id = r.order_id
   and r.driver_id is null
   and d.driver_id is not null;

-- Re-run the averages now that the rows point somewhere.
update public.drivers dr
   set average_rating = (
     select round(avg(r.delivery_stars)::numeric, 2)
       from public.order_ratings r
      where r.driver_id = dr.id and r.delivery_stars is not null
   );
