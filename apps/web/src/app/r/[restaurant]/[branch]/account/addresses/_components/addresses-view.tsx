'use client';

import * as React from 'react';
import { useTranslations } from 'next-intl';
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
import { Badge, Button, Card, IconButton, Sheet } from '@favornoms/ui';
import { useAuth } from '@/components/auth/use-auth';
import { pickerLabels } from '@/lib/picker-labels';
import { AccountHeader, SignInGate } from '../../_components/account-ui';

export function AddressesView({ base, branchId }: { base: string; branchId: string }) {
  const t = useTranslations();
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
  const [formError, setFormError] = React.useState<string | null>(null);

  const refresh = React.useCallback(
    async (cid: string) => {
      const supabase = getBrowserClient();
      const rows = await listCustomerAddresses(supabase, cid);
      setAddresses(rows);
      setBusy(false);
    },
    [],
  );

  React.useEffect(() => {
    if (!user) {
      setBusy(false);
      return;
    }
    const supabase = getBrowserClient();
    // One customer identity per restaurant (shared across branches); resolve/create it.
    void supabase
      .rpc('get_or_create_my_customer', { p_branch_id: branchId })
      .then(({ data }) => {
        const cid = data as string | null;
        if (cid) {
          setCustomerId(cid);
          void refresh(cid);
        } else {
          setBusy(false);
        }
      });
  }, [user, refresh, branchId]);

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

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!customerId) return;
    if (!addrText.trim()) {
      setFormError(t('checkout.errors.addressRequired'));
      return;
    }
    setSaving(true);
    setFormError(null);
    try {
      const supabase = getBrowserClient();
      await upsertCustomerAddress(supabase, {
        customer_id: customerId,
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
      setFormOpen(false);
      await refresh(customerId);
    } catch (err) {
      setFormError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const setAsDefault = async (a: SavedAddress) => {
    if (!customerId || a.is_default) return;
    const supabase = getBrowserClient();
    await upsertCustomerAddress(supabase, {
      customer_id: customerId,
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
    }).catch(() => undefined);
    await refresh(customerId);
  };

  const remove = async (a: SavedAddress) => {
    if (!customerId) return;
    if (!confirm('Delete this address?')) return;
    const supabase = getBrowserClient();
    await deleteCustomerAddress(supabase, a.id).catch(() => undefined);
    await refresh(customerId);
  };

  return (
    <div className="container max-w-2xl pb-24 pt-4">
      <AccountHeader base={base} title="Delivery addresses" />

      {loading ? null : !user ? (
        <SignInGate base={base} message="Sign in to save and manage your delivery addresses." />
      ) : (
        <div className="space-y-4">
          {busy ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : addresses.length === 0 ? (
            <Card className="p-8 text-center">
              <div className="mx-auto grid h-12 w-12 place-items-center rounded-full bg-primary/10 text-primary">
                <MapPin className="h-6 w-6" />
              </div>
              <p className="mt-3 font-semibold">No saved addresses</p>
              <p className="text-sm text-muted-foreground">
                Add one to check out faster next time.
              </p>
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
                          {a.label || 'Address'}
                          {a.is_default && <Badge variant="muted">Default</Badge>}
                        </p>
                        <p className="truncate text-sm text-muted-foreground">
                          {[a.address_line1, a.address_line2, a.city, a.state].filter(Boolean).join(', ')}
                        </p>
                        {a.delivery_notes && (
                          <p className="mt-0.5 truncate text-xs text-muted-foreground">
                            Note: {a.delivery_notes}
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
                          <Star className="h-3.5 w-3.5" /> Set default
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => openEdit(a)}
                        className="focus-ring inline-flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-xs font-medium text-muted-foreground hover:bg-muted"
                      >
                        <Pencil className="h-3.5 w-3.5" /> Edit
                      </button>
                      <button
                        type="button"
                        onClick={() => remove(a)}
                        className="focus-ring ml-auto inline-flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-xs font-medium text-danger hover:bg-danger/10"
                      >
                        <Trash2 className="h-3.5 w-3.5" /> Delete
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
              Add a new address
            </Button>
          )}
        </div>
      )}

      {/* Add / edit form */}
      <Sheet
        open={formOpen}
        onClose={() => setFormOpen(false)}
        side="bottom"
        title={editingId ? 'Edit address' : 'Add address'}
      >
        <form className="space-y-4 p-5" onSubmit={save}>
          <Field label="Label (optional)">
            <input
              className="input"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="Home, Work, Mom's…"
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
              <MapPin className="h-3.5 w-3.5" /> Location pinned
            </p>
          )}

          <Field label="Delivery instructions (optional)">
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
              maxLength={300}
              placeholder="e.g. Gate code 1234 · leave at the door"
              className="focus-ring w-full resize-none rounded-2xl border border-border bg-background px-4 py-3 text-base placeholder:text-muted-foreground"
            />
          </Field>

          <label className="flex items-center justify-between gap-3">
            <span className="text-sm font-medium">Set as default address</span>
            <button
              type="button"
              role="switch"
              aria-checked={isDefault}
              aria-label="Set as default address"
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

          {formError && <p className="text-sm font-medium text-danger">{formError}</p>}

          <Button type="submit" variant="gradient" size="xl" fullWidth loading={saving}>
            {editingId ? 'Save changes' : 'Save address'}
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
