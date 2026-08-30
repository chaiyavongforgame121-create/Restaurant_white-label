-- The rating sheet asked for food stars, driver stars and ONE comment box, so whatever the
-- customer wrote was filed against the restaurant no matter who it was about — "the rider
-- was great" landed in the merchant's Ratings page and the rider never saw it.
--
-- Splitting the sheet into two steps (driver first, then the restaurant) needs somewhere to
-- put the second piece of writing. `comment` stays the restaurant's, because that is what
-- getBranchRatings already reads and shows; driver_comment is new and belongs to the rider.
alter table public.order_ratings
  add column if not exists driver_comment text;

comment on column public.order_ratings.driver_comment is
  'Free text about the RIDER, collected in its own step. Deliberately separate from '
  '`comment`, which is about the restaurant and is what the merchant Ratings page reads.';
