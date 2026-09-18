'use client';

import * as React from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { LocateFixed, Map as MapIcon, MapPin, Pencil, Plus, Star, Trash2 } from 'lucide-react';
import { getBrowserClient } from '@favornoms/database/client';
import {
  deleteCustomerAddress,
  listCustomerAddresses,
  upsertCustomerAddress,
  type SavedAddress,
} from '@favornoms/database/queries';
import {
  AddressAutofillInput,
  GeolocationError,
  getCurrentPosition,
  LocationPicker,
  reverseGeocode,
  type GeolocationFailure,
  type ResolvedAddress,
} from '@favornoms/maps';
import { DEFAULT_UI_LOCALE, isUiLocale } from '@favornoms/shared';
import { Badge, Button, Card, IconButton, Sheet } from '@favornoms/ui';
import { useAuth } from '@/components/auth/use-auth';
import { customerErrorKey, resolveMyCustomerId } from '@/lib/customer';
import { pickerLabels } from '@/lib/picker-labels';
import { AccountHeader, SignInGate } from '../../_components/account-ui';

/** Messages (root keys) this page can show for a failed identity, list, save or delete. */
type AddressErrorKey =
  | 'checkout.errors.addressRequired'
  | 'account.addresses.errors.line1Required'
  | 'account.addresses.errors.notFound'
  | 'account.addresses.errors.forbidden'
  | 'account.addresses.errors.loadFailed'
  | 'account.errors.sessionExpired'
  | 'account.errors.branchNotFound'
  | 'account.errors.profileUnavailable'
  | 'account.errors.generic';

// upsert/deleteCustomerAddress wrap the Postgres error as
// `upsert_address_failed:<msg>` — unwrap it and put the known codes into words
// so a failed save actually tells the diner what to do. Anything else gets a
// generic line: a raw Postgres message means nothing to a diner in any language.
function addressErrorKey(err: unknown): AddressErrorKey {
  const message = err instanceof Error ? err.message : String(err ?? '');
  const raw = message.replace(/^(upsert_address_failed|delete_address_failed):/, '');
  if (raw.includes('line1_required')) return 'account.addresses.errors.line1Required';
  if (raw.includes('address_not_found')) return 'account.addresses.errors.notFound';
  if (raw.includes('forbidden')) return 'account.addresses.errors.forbidden';
  if (raw.includes('auth_required')) return 'account.errors.sessionExpired';
  const customer = customerErrorKey(raw);
  if (customer) return `account.errors.${customer}`;
  return 'account.errors.generic';
}

/** Why the address book could not be read: an identity failure we can name, else a load failure. */
function loadErrorKey(err: unknown): AddressErrorKey {
  const customer = customerErrorKey(err);
  return customer ? `account.errors.${customer}` : 'account.addresses.errors.loadFailed';
}

export function AddressesView({ base, branchId }: { base: string; branchId: string }) {
  const t = useTranslations();
  const rawLocale = useLocale();
  const locale = isUiLocale(rawLocale) ? rawLocale : DEFAULT_UI_LOCALE;
  const { user, loading } = useAuth();

  const [customerId, setCustomerId] = React.useState<string | null>(null);
  const [addresses, setAddresses] = React.useState<SavedAddress[]>([]);
  const [busy, setBusy] = React.useState(true);
  const [branchCenter, setBranchCenter] = React.useState<{ lat: number; lng: number } | null>(null);

  // Add/edit form state
  const [formOpen, setFormOpen] = React.useState(false);
  const [editingId, setEditingId] = React.useState<string | null>(null);
  const [label, setLabel] = React.useState('');
  const [addrText, setAddrText] = React.useState('');
  const [coords, setCoords] = React.useState<{ lat: number; lng: number } | null>(null);
  const [meta, setMeta] = React.useState<{
    line2?: string;
    city?: string;
    state?: string;
    postal_code?: string;
  } | null>(null);
  const [notes, setNotes] = React.useState('');
  const [isDefault, setIsDefault] = React.useState(false);
  const resolvedRef = React.useRef<string | null>(null);
  const [pickerOpen, setPickerOpen] = React.useState(false);
  const [locatingQuick, setLocatingQuick] = React.useState(false);
  const [geoError, setGeoError] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);
  // Errors are held as message keys and translated at render.
  const [formError, setFormError] = React.useState<AddressErrorKey | null>(null);
  // Identity/list failures. Without these the page silently renders an empty
  // address book and "Save address" does nothing at all.
  const [loadError, setLoadError] = React.useState<AddressErrorKey | null>(null);
  const [actionError, setActionError] = React.useState<AddressErrorKey | null>(null);
  const [reloadKey, setReloadKey] = React.useState(0);

  const refresh = React.useCallback(
    async (cid: string) => {
      const supabase = getBrowserClient();
      // listCustomerAddresses now throws on a read failure instead of returning [].
      // Surface it as loadError (the Retry card) so a failed reload never masquerades
      // as "No saved addresses", and re-throw so callers know it did not complete.
      try {
        const rows = await listCustomerAddresses(supabase, cid);
        setAddresses(rows);
        setLoadError(null);
      } catch (err) {
        console.error('[addresses] listing saved addresses failed', err);
        setLoadError(loadErrorKey(err));
        throw err;
      }
    },
    [],
  );

  React.useEffect(() => {
    if (!user) {
      setBusy(false);
      return;
    }
    let cancelled = false;
    setBusy(true);
    setLoadError(null);
    void (async () => {
      try {
        // This branch's own record of the diner, whose address book this is (each branch
        // keeps its own); resolve/create it.
        const cid = await resolveMyCustomerId(branchId);
        if (cancelled) return;
        setCustomerId(cid);
        await refresh(cid);
      } catch (err) {
        if (!cancelled) setLoadError(loadErrorKey(err));
      } finally {
        if (!cancelled) setBusy(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [user, refresh, branchId, reloadKey]);

  React.useEffect(() => {
    const supabase = getBrowserClient();
    void supabase
      .from('branches')
      .select('geo_lat, geo_lng')
      .eq('id', branchId)
      .maybeSingle()
      .then(({ data }) => {
        if (data?.geo_lat != null && data?.geo_lng != null) {
          setBranchCenter({ lat: Number(data.geo_lat), lng: Number(data.geo_lng) });
        }
      });
  }, [branchId]);

  const resetForm = () => {
    setEditingId(null);
    setLabel('');
    setAddrText('');
    setCoords(null);
    setMeta(null);
    setNotes('');
    setIsDefault(false);
    resolvedRef.current = null;
    setGeoError(null);
    setFormError(null);
  };

  const openNew = () => {
    resetForm();
    setIsDefault(addresses.length === 0); // first address defaults on
    setFormOpen(true);
  };

  const openEdit = (a: SavedAddress) => {
    setEditingId(a.id);
    // Prefill the visible field with line1 ONLY — line2 stays structured in meta
    // and is re-sent separately on save, so it never gets folded into line1.
    const line1 = a.address_line1 ?? '';
    setLabel(a.label ?? '');
    setAddrText(line1);
    resolvedRef.current = line1;
    setCoords(a.lat != null && a.lng != null ? { lat: a.lat, lng: a.lng } : null);
    setMeta({
      line2: a.address_line2 ?? undefined,
      city: a.city ?? undefined,
      state: a.state ?? undefined,
      postal_code: a.postal_code ?? undefined,
    });
    setNotes(a.delivery_notes ?? '');
    setIsDefault(!!a.is_default);
    setGeoError(null);
    setFormError(null);
    setFormOpen(true);
  };

  const applyResolved = (a: ResolvedAddress) => {
    const line1 = [a.line1, a.line2].filter(Boolean).join(', ');
    resolvedRef.current = line1;
    setAddrText(line1);
    setCoords({ lat: a.lat, lng: a.lng });
    setMeta({ line2: a.line2, city: a.city, state: a.state, postal_code: a.postal_code });
    setGeoError(null);
    setFormError(null);
  };

  const geoFailureMessage = (reason: GeolocationFailure) => {
    switch (reason) {
      case 'insecure_context':
        return t('checkout.geo.insecure');
      case 'unsupported':
        return t('checkout.geo.unsupported');
      case 'denied':
        return t('checkout.geo.denied');
      case 'timeout':
        return t('checkout.geo.timeout');
      default:
        return t('checkout.geo.unavailable');
    }
  };

  const handleQuickCurrentLocation = async () => {
    setGeoError(null);
    setLocatingQuick(true);
    try {
      const pos = await getCurrentPosition();
      const resolved = await reverseGeocode(pos);
      applyResolved(
        resolved ?? {
          line1: `${pos.lat.toFixed(5)}, ${pos.lng.toFixed(5)}`,
          lat: pos.lat,
          lng: pos.lng,
        },
      );
    } catch (e) {
      const reason: GeolocationFailure = e instanceof GeolocationError ? e.reason : 'unavailable';
      setGeoError(geoFailureMessage(reason));
    } finally {
      setLocatingQuick(false);
    }
  };

  // The address book is useless without an identity, so never fail silently:
  // re-resolve on demand and let the caller surface whatever went wrong.
  const ensureCustomerId = async (): Promise<string> => {
    if (customerId) return customerId;
    const cid = await resolveMyCustomerId(branchId);
    setCustomerId(cid);
    setLoadError(null);
    return cid;
  };

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!addrText.trim()) {
      setFormError('checkout.errors.addressRequired');
      return;
    }
    setSaving(true);
    setFormError(null);
    try {
      const cid = await ensureCustomerId();
      const supabase = getBrowserClient();
      await upsertCustomerAddress(supabase, {
        customer_id: cid,
        address_id: editingId ?? undefined,
        label: label.trim() || null,
        line1: addrText.trim(),
        line2: meta?.line2 ?? null,
        city: meta?.city ?? null,
        state: meta?.state ?? null,
        postal_code: meta?.postal_code ?? null,
        lat: coords?.lat ?? null,
        lng: coords?.lng ?? null,
        notes: notes.trim() || null,
        is_default: isDefault,
      });
      // The write succeeded (upsertCustomerAddress throws otherwise). Close the sheet,
      // then reload — a reload failure here must NOT look like the save failed, so it
      // lands on the list-level Retry card (via refresh -> loadError), not the sheet.
      setFormOpen(false);
      await refresh(cid).catch(() => undefined);
    } catch (err) {
      console.error('[addresses] saving an address failed', err);
      setFormError(addressErrorKey(err));
    } finally {
      setSaving(false);
    }
  };

  const setAsDefault = async (a: SavedAddress) => {
    if (a.is_default) return;
    setActionError(null);
    try {
      const cid = await ensureCustomerId();
      const supabase = getBrowserClient();
      await upsertCustomerAddress(supabase, {
        customer_id: cid,
        address_id: a.id,
        label: a.label,
        line1: a.address_line1,
        line2: a.address_line2,
        city: a.city,
        state: a.state,
        postal_code: a.postal_code,
        lat: a.lat,
        lng: a.lng,
        notes: a.delivery_notes,
        is_default: true,
      });
      await refresh(cid);
    } catch (err) {
      console.error('[addresses] setting the default address failed', err);
      setActionError(addressErrorKey(err));
    }
  };

  const remove = async (a: SavedAddress) => {
    if (!confirm(t('account.addresses.confirmDelete'))) return;
    setActionError(null);
    try {
      const cid = await ensureCustomerId();
      const supabase = getBrowserClient();
      await deleteCustomerAddress(supabase, a.id);
      await refresh(cid);
    } catch (err) {
      console.error('[addresses] deleting an address failed', err);
      setActionError(addressErrorKey(err));
    }
  };

  return (
    <div className="container max-w-2xl pb-24 pt-4">
      <AccountHeader base={base} title={t('account.sections.addresses')} />

      {loading ? null : !user ? (
        <SignInGate base={base} message={t('account.addresses.signInPrompt')} />
      ) : (
        <div className="space-y-4">
          {loadError && (
            <Card className="border-danger/30 bg-danger/5 p-4">
              <p className="text-sm font-medium text-danger">{t(loadError)}</p>
              <Button
                type="button"
                variant="ghost"
                size="md"
                className="mt-2"
                onClick={() => setReloadKey((k) => k + 1)}
              >
                {t('account.addresses.retry')}
              </Button>
            </Card>
          )}
          {actionError && (
            <Card className="border-danger/30 bg-danger/5 p-4 text-sm text-danger">
              {t(actionError)}
            </Card>
          )}
          {busy ? (
            <p className="text-sm text-muted-foreground">{t('account.loading')}</p>
          ) : addresses.length === 0 ? (
            <Card className="p-8 text-center">
              <div className="mx-auto grid h-12 w-12 place-items-center rounded-full bg-primary/10 text-primary">
                <MapPin className="h-6 w-6" />
              </div>
              <p className="mt-3 font-semibold">{t('account.addresses.emptyTitle')}</p>
              <p className="text-sm text-muted-foreground">{t('account.addresses.emptyBody')}</p>
            </Card>
          ) : (
            <ul className="space-y-2">
              {addresses.map((a) => (
                <li key={a.id}>
                  <Card className="p-4">
                    <div className="flex items-start gap-3">
                      <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary">
                        <MapPin className="h-5 w-5" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="flex items-center gap-2 font-semibold">
                          {a.label || t('account.addresses.fallbackLabel')}
                          {a.is_default && <Badge variant="muted">{t('account.addresses.defaultBadge')}</Badge>}
                        </p>
                        <p className="truncate text-sm text-muted-foreground">
                          {[a.address_line1, a.address_line2, a.city, a.state].filter(Boolean).join(', ')}
                        </p>
                        {a.delivery_notes && (
                          <p className="mt-0.5 truncate text-xs text-muted-foreground">
                            {t('account.addresses.note', { note: a.delivery_notes })}
                          </p>
                        )}
                      </div>
                    </div>
                    <div className="mt-3 flex flex-wrap items-center gap-1.5">
                      {!a.is_default && (
                        <button
                          type="button"
                          onClick={() => setAsDefault(a)}
                          className="focus-ring inline-flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-xs font-medium text-muted-foreground hover:bg-muted"
                        >
                          <Star className="h-3.5 w-3.5" /> {t('account.addresses.setDefault')}
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => openEdit(a)}
                        className="focus-ring inline-flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-xs font-medium text-muted-foreground hover:bg-muted"
                      >
                        <Pencil className="h-3.5 w-3.5" /> {t('account.addresses.edit')}
                      </button>
                      <button
                        type="button"
                        onClick={() => remove(a)}
                        className="focus-ring ml-auto inline-flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-xs font-medium text-danger hover:bg-danger/10"
                      >
                        <Trash2 className="h-3.5 w-3.5" /> {t('account.addresses.delete')}
                      </button>
                    </div>
                  </Card>
                </li>
              ))}
            </ul>
          )}

          {!busy && (
            <Button
              type="button"
              variant="gradient"
              size="lg"
              fullWidth
              leftIcon={<Plus className="h-4 w-4" />}
              onClick={openNew}
            >
              {t('account.addresses.addNew')}
            </Button>
          )}
        </div>
      )}

      {/* Add / edit form */}
      <Sheet
        open={formOpen}
        onClose={() => setFormOpen(false)}
        side="bottom"
        title={editingId ? t('account.addresses.form.editTitle') : t('account.addresses.form.addTitle')}
      >
        <form className="space-y-4 p-5" onSubmit={save}>
          <Field label={t('account.addresses.form.label')}>
            <input
              className="input"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder={t('account.addresses.form.labelPlaceholder')}
            />
          </Field>

          <Field label={t('checkout.address')}>
            <AddressAutofillInput
              value={addrText}
              onChange={(text) => {
                setAddrText(text);
                setFormError(null);
                if (text !== resolvedRef.current) {
                  resolvedRef.current = null;
                  setCoords(null);
                  setMeta(null);
                }
              }}
              onResolved={(a) => {
                resolvedRef.current = a.line1;
                setCoords({ lat: a.lat, lng: a.lng });
                setMeta({ line2: a.line2, city: a.city, state: a.state, postal_code: a.postal_code });
                setFormError(null);
              }}
              placeholder={t('checkout.addressPlaceholder')}
              locale={locale}
              inputClassName="input"
              aria-label={t('checkout.address')}
            />
          </Field>

          <div className="grid grid-cols-2 gap-2">
            <Button
              type="button"
              variant="ghost"
              size="md"
              leftIcon={<MapIcon className="h-4 w-4" />}
              onClick={() => setPickerOpen(true)}
            >
              {t('checkout.setOnMap')}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="md"
              leftIcon={<LocateFixed className="h-4 w-4" />}
              loading={locatingQuick}
              onClick={handleQuickCurrentLocation}
            >
              {t('checkout.useCurrentLocation')}
            </Button>
          </div>
          {geoError && <p className="text-xs text-warning">{geoError}</p>}
          {coords && resolvedRef.current && (
            <p className="flex items-center gap-1 text-xs font-medium text-success">
              <MapPin className="h-3.5 w-3.5" /> {t('account.addresses.form.pinned')}
            </p>
          )}

          <Field label={t('account.addresses.form.instructions')}>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
              maxLength={300}
              placeholder={t('account.addresses.form.instructionsPlaceholder')}
              className="focus-ring w-full resize-none rounded-2xl border border-border bg-background px-4 py-3 text-base placeholder:text-muted-foreground"
            />
          </Field>

          <label className="flex items-center justify-between gap-3">
            <span className="text-sm font-medium">{t('account.addresses.form.setDefault')}</span>
            <button
              type="button"
              role="switch"
              aria-checked={isDefault}
              aria-label={t('account.addresses.form.setDefault')}
              onClick={() => setIsDefault((d) => !d)}
              className={`focus-ring relative h-7 w-12 shrink-0 rounded-full transition-colors ${
                isDefault ? 'bg-primary' : 'bg-muted'
              }`}
            >
              <span
                className={`absolute top-1 h-5 w-5 rounded-full bg-white shadow transition-transform ${
                  isDefault ? 'translate-x-6' : 'translate-x-1'
                }`}
              />
            </button>
          </label>

          {formError && <p className="text-sm font-medium text-danger">{t(formError)}</p>}

          <Button type="submit" variant="gradient" size="xl" fullWidth loading={saving}>
            {editingId ? t('account.addresses.form.saveChanges') : t('account.addresses.form.save')}
          </Button>
        </form>
      </Sheet>

      {/* Map picker (opens over the form) */}
      <Sheet
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        side="bottom"
        title={t('checkout.picker.title')}
      >
        <LocationPicker
          className="h-[70vh]"
          initial={coords}
          fallbackCenter={branchCenter}
          onConfirm={(a) => {
            applyResolved(a);
            setPickerOpen(false);
          }}
          locale={locale}
          labels={pickerLabels(t)}
        />
      </Sheet>

      <style jsx global>{`
        .input {
          width: 100%;
          height: 48px;
          padding: 0 1rem;
          font-size: 16px;
          border-radius: 0.875rem;
          border: 1px solid hsl(var(--border));
          background: hsl(var(--background));
          outline: none;
          transition: border-color 0.15s, box-shadow 0.15s;
        }
        .input:focus-visible {
          border-color: hsl(var(--primary));
          box-shadow: 0 0 0 3px hsl(var(--primary) / 0.18);
        }
      `}</style>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium">{label}</span>
      {children}
    </label>
  );
}
