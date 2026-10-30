import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createTranslator } from 'next-intl';
import { copiedFrom, groupUsage, linkChanges, namePreview, stillLinkable, type GroupLink } from './modifier-usage';

/** A plain link to a group: a library group, or one made on the dish. */
const link = (groupId: string): GroupLink => ({ modifier_group_id: groupId, modifier_groups: { source_group_id: null } });
/** The dish's own copy `copyId` of the library group `sourceId`. */
const copy = (copyId: string, sourceId: string): GroupLink => ({
  modifier_group_id: copyId,
  modifier_groups: { source_group_id: sourceId },
});
const dish = (id: string, ...links: GroupLink[]) => ({ id, name: id, menu_item_modifiers: links });

describe('copiedFrom', () => {
  it('reads the source of a copy, as an object or as the array the generated types describe', () => {
    expect(copiedFrom(copy('c1', 'spicy'))).toBe('spicy');
    expect(copiedFrom({ modifier_group_id: 'c1', modifier_groups: [{ source_group_id: 'spicy' }] })).toBe('spicy');
  });

  it('is null for a library group, a group made on the dish, or a group the read did not bring', () => {
    expect(copiedFrom(link('spicy'))).toBeNull();
    expect(copiedFrom({ modifier_group_id: 'g', modifier_groups: null })).toBeNull();
    expect(copiedFrom({ modifier_group_id: 'g', modifier_groups: [] })).toBeNull();
    expect(copiedFrom({ modifier_group_id: 'g' })).toBeNull();
  });
});

describe('groupUsage', () => {
  it('tells the dishes that link the library group from the dishes that carry their own copy', () => {
    const items = [
      dish('pad-thai', link('spicy'), link('size')),
      dish('tom-yum', copy('c1', 'spicy')),
      dish('green-curry', link('size')),
      dish('fried-rice', copy('c2', 'spicy'), link('size')),
    ];
    const usage = groupUsage(items, 'spicy');
    expect(usage.linked.map((m) => m.id)).toEqual(['pad-thai']);
    expect(usage.customized.map((m) => m.id)).toEqual(['tom-yum', 'fried-rice']);
    expect(groupUsage(items, 'size').linked.map((m) => m.id)).toEqual(['pad-thai', 'green-curry', 'fried-rice']);
    expect(groupUsage(items, 'size').customized).toEqual([]);
  });

  it('counts a dish with a copy as customized for that copy’s source only, never as linked to it', () => {
    const items = [dish('tom-yum', copy('c1', 'size'))];
    expect(groupUsage(items, 'size')).toEqual({ linked: [], customized: [items[0]] });
    expect(groupUsage(items, 'spicy')).toEqual({ linked: [], customized: [] });
  });

  it('copes with a dish read without links', () => {
    expect(groupUsage([{ id: 'x', menu_item_modifiers: null }, { id: 'y' }], 'spicy')).toEqual({
      linked: [],
      customized: [],
    });
  });
});

describe('linkChanges', () => {
  const items = [
    dish('pad-thai', link('spicy')),
    dish('tom-yum', copy('c1', 'spicy')),
    dish('green-curry'),
    dish('fried-rice', link('spicy')),
  ];

  it('links the ticked dishes without the group and unlinks the unticked ones that have it', () => {
    expect(linkChanges(items, 'spicy', new Set(['pad-thai', 'green-curry']))).toEqual({
      toAdd: ['green-curry'],
      toRemove: ['fried-rice'],
    });
  });

  it('writes nothing when the ticks match what is linked', () => {
    expect(linkChanges(items, 'spicy', new Set(['pad-thai', 'fried-rice']))).toEqual({ toAdd: [], toRemove: [] });
  });

  it('never links a dish that carries its own copy, even when its box is ticked', () => {
    expect(linkChanges(items, 'spicy', new Set(['pad-thai', 'fried-rice', 'tom-yum'])).toAdd).toEqual([]);
  });

  it('never unlinks such a dish either, even one that somehow shows both versions', () => {
    const both = [dish('tom-yum', link('spicy'), copy('c1', 'spicy')), dish('pad-thai', link('spicy'))];
    expect(linkChanges(both, 'spicy', new Set())).toEqual({ toAdd: [], toRemove: ['pad-thai'] });
  });
});

describe('stillLinkable', () => {
  it('drops dishes that got the group or their own copy of it since the page was loaded', () => {
    const fresh = [
      dish('pad-thai', link('spicy')),
      dish('tom-yum', copy('c1', 'spicy')),
      dish('green-curry', link('size')),
    ];
    expect(stillLinkable(fresh, 'spicy', ['pad-thai', 'tom-yum', 'green-curry'])).toEqual(['green-curry']);
  });

  it('keeps a dish the read does not show, so the insert decides as before', () => {
    expect(stillLinkable([], 'spicy', ['new-dish'])).toEqual(['new-dish']);
  });
});

describe('namePreview', () => {
  const named = (...names: string[]) => names.map((name) => ({ name }));

  it('names up to three dishes and counts the rest', () => {
    expect(namePreview(named('Pad Thai'))).toEqual({ names: 'Pad Thai', more: 0 });
    expect(namePreview(named('A', 'B', 'C'))).toEqual({ names: 'A, B, C', more: 0 });
    expect(namePreview(named('A', 'B', 'C', 'D', 'E'))).toEqual({ names: 'A, B, C', more: 2 });
    expect(namePreview([])).toEqual({ names: '', more: 0 });
  });
});

describe('Modifier groups sentences about customized dishes', () => {
  // Every key the page renders for dishes with their own copy, with the values it passes.
  const USED: Array<[string, Record<string, string | number>?]> = [
    ['modifiers.customizedCount', { count: 1 }],
    ['modifiers.customizedCount', { count: 4 }],
    ['modifiers.customizedNote', { names: 'Pad Thai', count: 1 }],
    ['modifiers.customizedNote', { names: 'Pad Thai, Tom Yum', count: 2 }],
    ['modifiers.customizedNoteMore', { names: 'Pad Thai, Tom Yum, Larb', more: 1 }],
    ['modifiers.customizedNoteMore', { names: 'Pad Thai, Tom Yum, Larb', more: 5 }],
    ['modifiers.deleteGroupConfirm.bodyWithCopies', { count: 1 }],
    ['modifiers.deleteGroupConfirm.bodyWithCopies', { count: 3 }],
    ['modifiers.links.customized'],
    ['modifiers.links.customizedHint'],
  ];

  for (const locale of ['en', 'es', 'th', 'vi']) {
    const file = path.resolve(__dirname, `../../../../../../../messages/${locale}/menuExtras.json`);
    const messages = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    const t = createTranslator({
      locale,
      messages: { menuExtras: messages },
      namespace: 'menuExtras',
      // Throw instead of printing the key, so a missing sentence or a placeholder the page does not
      // pass fails here rather than in front of a merchant.
      onError: (error) => {
        throw error;
      },
    }) as unknown as (key: string, values?: Record<string, string | number>) => string;

    it(`renders every sentence in ${locale}, with the dish names in it`, () => {
      for (const [key, values] of USED) {
        const text = t(key, values);
        expect(text, `${locale}: ${key}`).toBeTruthy();
        expect(text, `${locale}: ${key}`).not.toMatch(/[{}]/);
        if (typeof values?.names === 'string') expect(text, `${locale}: ${key}`).toContain(values.names);
      }
    });

    it(`names the picker's badge in the picker's hint in ${locale}`, () => {
      expect(t('modifiers.links.customizedHint')).toContain(t('modifiers.links.customized'));
    });

    // The hint sends the merchant to a button in the dish's editor by its label, so the label has to
    // be the one that button shows (menu.json, modifiers.source.useLibrary).
    it(`quotes the dish editor's “Use the library version” button as it reads in ${locale}`, () => {
      const menuFile = path.resolve(__dirname, `../../../../../../../messages/${locale}/menu.json`);
      const menu = JSON.parse(readFileSync(menuFile, 'utf8')) as { modifiers?: { source?: { useLibrary?: unknown } } };
      const button = menu.modifiers?.source?.useLibrary;
      expect(typeof button, `${locale} menu.modifiers.source.useLibrary`).toBe('string');
      expect(t('modifiers.links.customizedHint')).toContain(`“${button as string}”`);
    });
  }
});
