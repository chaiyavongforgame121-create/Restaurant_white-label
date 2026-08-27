-- Per-restaurant PWA install icons.
--
-- brands.favicon_url already drives the browser-tab icon and the iOS apple-touch-icon.
-- It cannot drive the web app manifest: a manifest icon entry must declare a `sizes`
-- that matches the bytes, and a merchant upload of unknown dimensions declared as
-- 192x192 fails Chrome's installability check, which removes the install prompt
-- entirely -- strictly worse than an unbranded icon.
--
-- These hold exactly-sized PNGs produced by the admin uploader, so the manifest can
-- name honest sizes.
alter table public.brands
  add column if not exists icon_192_url text,
  add column if not exists icon_512_url text,
  add column if not exists icon_maskable_512_url text;

comment on column public.brands.icon_192_url is
  'Exactly 192x192 PNG for the web app manifest (purpose: any). Written only by the admin icon uploader, which normalises dimensions.';
comment on column public.brands.icon_512_url is
  'Exactly 512x512 PNG for the web app manifest (purpose: any).';
comment on column public.brands.icon_maskable_512_url is
  'Exactly 512x512 PNG with the mark inset to the maskable safe zone and an opaque background (purpose: maskable).';
