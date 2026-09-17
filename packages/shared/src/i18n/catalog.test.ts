// Every interface language must say the same things as English: the same keys, the same
// {placeholders} and the same <tags>. A missing key only falls back to English at runtime, but a
// renamed placeholder silently prints "{count}" to a diner, and an extra key is a sign a
// translation drifted from the screen it belongs to.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { UI_LOCALES, isUiLocale, mergeMessages, negotiateUiLocale, intlLocaleFor } from './index';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const APPS = ['web', 'admin', 'driver'] as const;

type Tree = { [key: string]: string | Tree };

function leaves(tree: Tree, prefix = ''): Map<string, string> {
  const out = new Map<string, string>();
  for (const [key, value] of Object.entries(tree)) {
    const at = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'string') out.set(at, value);
    else for (const [k, v] of leaves(value, at)) out.set(k, v);
  }
  return out;
}

/** Argument names ({name}, {count, plural, …}) and rich-text tag names (<strong>…</strong>). */
function signature(message: string): string {
  const args = new Set<string>();
  const re = /\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*[,}]/g;
  for (let m = re.exec(message); m; m = re.exec(message)) args.add(`arg:${m[1]}`);
  const tags = /<([A-Za-z][A-Za-z0-9]*)>/g;
  for (let m = tags.exec(message); m; m = tags.exec(message)) args.add(`tag:${m[1]}`);
  return [...args].sort().join(' ');
}

function read(app: string, locale: string, file: string): Tree {
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'apps', app, 'messages', locale, file), 'utf8')) as Tree;
}

describe('interface message catalogues', () => {
  for (const app of APPS) {
    const enDir = path.join(ROOT, 'apps', app, 'messages', 'en');
    const files = fs.readdirSync(enDir).filter((f) => f.endsWith('.json'));

    describe(app, () => {
      it('has a file for every namespace in every language', () => {
        for (const locale of UI_LOCALES) {
          const dir = path.join(ROOT, 'apps', app, 'messages', locale);
          expect(fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort()).toEqual([...files].sort());
        }
      });

      for (const file of files) {
        it(`${file}: English is complete and every language matches it`, () => {
          const en = leaves(read(app, 'en', file));
          for (const [key, value] of en) {
            expect(value.trim(), `${app}/en/${file} ${key} is empty`).not.toBe('');
          }
          for (const locale of UI_LOCALES) {
            if (locale === 'en') continue;
            const other = leaves(read(app, locale, file));
            const missing = [...en.keys()].filter((k) => !other.has(k));
            const extra = [...other.keys()].filter((k) => !en.has(k));
            expect(missing, `${app}/${locale}/${file} is missing keys`).toEqual([]);
            expect(extra, `${app}/${locale}/${file} has keys English does not`).toEqual([]);
            for (const [key, value] of other) {
              expect(value.trim(), `${app}/${locale}/${file} ${key} is empty`).not.toBe('');
              expect(signature(value), `${app}/${locale}/${file} ${key} placeholders differ from English`).toBe(
                signature(en.get(key) ?? ''),
              );
            }
          }
        });
      }
    });
  }
});

describe('locale helpers', () => {
  it('negotiates by quality and primary subtag', () => {
    expect(negotiateUiLocale('th-TH,th;q=0.9,en-US;q=0.8')).toBe('th');
    expect(negotiateUiLocale('fr-FR,vi;q=0.7,es;q=0.9')).toBe('es');
    expect(negotiateUiLocale('de-DE')).toBe('en');
    expect(negotiateUiLocale(null)).toBe('en');
    expect(negotiateUiLocale('vi;q=0')).toBe('en');
  });

  it('keeps Thai dates on the Gregorian calendar', () => {
    expect(intlLocaleFor('th')).toBe('th-TH-u-ca-gregory');
    expect(new Intl.DateTimeFormat(intlLocaleFor('th'), { year: 'numeric' }).format(new Date('2026-09-17T00:00:00Z'))).toContain('2026');
  });

  it('validates locales', () => {
    expect(isUiLocale('vi')).toBe(true);
    expect(isUiLocale('zh')).toBe(false);
    expect(isUiLocale(undefined)).toBe(false);
  });

  it('lays a translation over English without letting blanks through', () => {
    const en = { a: 'Hello', b: { c: 'World', d: 'Kept' } };
    expect(mergeMessages(en, { a: 'Hola', b: { c: '' } })).toEqual({ a: 'Hola', b: { c: 'World', d: 'Kept' } });
  });
});
