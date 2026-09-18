import { describe, expect, it } from 'vitest';
import { changedSettings, createSettingsBaseline } from './patch-settings';

describe('changedSettings', () => {
  it('leaves out keys whose value did not change, whatever order jsonb returned them in', () => {
    const current = {
      payment_methods: { scheduled: { transfer: false, card: true, cash: true }, asap: { cash: true, card: true, transfer: false } },
      service_fee_percent: 5,
    };
    const next = {
      payment_methods: { asap: { cash: true, card: true, transfer: false }, scheduled: { cash: true, card: true, transfer: false } },
      service_fee_percent: 5,
    };
    expect(changedSettings(current, next)).toEqual({});
  });

  it('keeps only the keys that changed', () => {
    const current = { orders_paused: true, busy_extra_prep_min: 10, delivery_base_fee: 2 };
    const next = { orders_paused: true, busy_extra_prep_min: 10, delivery_base_fee: 3 };
    expect(changedSettings(current, next)).toEqual({ delivery_base_fee: 3 });
  });

  it('sends a key the row does not have yet, and never an undefined one', () => {
    expect(changedSettings({}, { tip_config: { delivery: { distribution: { driver: 100, house: 0 } } }, x: undefined })).toEqual({
      tip_config: { delivery: { distribution: { driver: 100, house: 0 } } },
    });
    expect(changedSettings(null, { scheduling_enabled: true })).toEqual({ scheduling_enabled: true });
  });

  it('treats a changed array element or a removed nested key as a change', () => {
    expect(changedSettings({ perks: ['a', 'b'] }, { perks: ['a', 'c'] })).toEqual({ perks: ['a', 'c'] });
    expect(changedSettings({ o: { a: 1, b: 2 } }, { o: { a: 1 } })).toEqual({ o: { a: 1 } });
    expect(changedSettings({ qr: null }, { qr: { image_url: null } })).toEqual({ qr: { image_url: null } });
  });
});

describe('createSettingsBaseline', () => {
  const layout = (menuLayout: string) => ({ storefront_override: { menuLayout } });

  it('sends an undo made before the refresh lands (grid, then back to list)', () => {
    const baseline = createSettingsBaseline(layout('list'));
    expect(baseline.diff(layout('grid'))).toEqual(layout('grid'));
    baseline.commit(layout('grid'));
    // The rendered settings still say list; the controls were last saved as grid.
    expect(baseline.diff(layout('list'))).toEqual(layout('list'));
    baseline.commit(layout('list'));
    expect(baseline.diff(layout('list'))).toEqual({});
  });

  it('keeps untouched keys out after a save, and never records undefined', () => {
    const baseline = createSettingsBaseline({ service_fee_percent: 5, orders_paused: false });
    baseline.commit({ service_fee_percent: 7, x: undefined });
    expect(baseline.diff({ service_fee_percent: 7, orders_paused: false })).toEqual({});
    expect(baseline.diff({ x: 1 })).toEqual({ x: 1 });
  });

  it('starts from nothing when the row has no settings', () => {
    expect(createSettingsBaseline(null).diff({ scheduling_enabled: true })).toEqual({ scheduling_enabled: true });
  });
});
