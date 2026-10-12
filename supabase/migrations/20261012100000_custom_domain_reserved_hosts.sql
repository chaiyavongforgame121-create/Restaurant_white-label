-- A restaurant's custom domain may not be one of the platform's own hosts.
--
-- Since 2026-10-12 the apps run on app./admin./go.favornoms.com, with the old *.vercel.app hosts
-- still serving. The storefront middleware sends any host it does not know as a platform host to
-- public.resolve_custom_domain, and nothing stopped an owner from typing one of those hosts into
-- their branch or restaurant settings: a merchant who saved 'restaurant-white-label-web.vercel.app'
-- (or any favornoms.com name the middleware list misses) would have had the platform's own root
-- page rewritten to their storefront. No row has a custom domain today, so the checks validate
-- immediately.
alter table public.branches
  add constraint branches_custom_domain_not_platform_host
  check (custom_domain is null
         or (custom_domain !~* '(^|\.)favornoms\.com\.?$' and custom_domain !~* '\.vercel\.app\.?$'));

alter table public.restaurants
  add constraint restaurants_custom_domain_not_platform_host
  check (custom_domain is null
         or (custom_domain !~* '(^|\.)favornoms\.com\.?$' and custom_domain !~* '\.vercel\.app\.?$'));

comment on constraint branches_custom_domain_not_platform_host on public.branches is
  'favornoms.com and *.vercel.app are the platform''s own hosts; a merchant domain may not claim them.';
comment on constraint restaurants_custom_domain_not_platform_host on public.restaurants is
  'favornoms.com and *.vercel.app are the platform''s own hosts; a merchant domain may not claim them.';
