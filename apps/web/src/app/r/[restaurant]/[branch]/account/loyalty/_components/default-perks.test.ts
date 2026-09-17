// The loyalty page shows the platform's stock benefit line for a tier the merchant never wrote
// perks for. That wording lives in DEFAULT_TIER_PERKS (the admin screen shows it to merchants as
// the copy they are about to replace), and the storefront shows it through `loyalty.defaultPerks.*`
// so it can be translated. English must stay word for word the same as the database package.

import { describe, expect, it } from 'vitest';
import { DEFAULT_TIER_PERKS } from '@favornoms/database/queries';
import en from '../../../../../../../../messages/en/loyalty.json';

describe('loyalty.defaultPerks', () => {
  it('matches DEFAULT_TIER_PERKS in English, one line per tier', () => {
    const catalogue = en.defaultPerks as Record<string, string>;
    expect(Object.keys(catalogue).sort()).toEqual(Object.keys(DEFAULT_TIER_PERKS).sort());
    for (const [tier, lines] of Object.entries(DEFAULT_TIER_PERKS)) {
      expect([catalogue[tier]], tier).toEqual(lines);
    }
  });
});
