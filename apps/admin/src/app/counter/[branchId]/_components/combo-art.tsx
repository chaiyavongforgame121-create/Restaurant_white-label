'use client';

import Image from 'next/image';
import { Package } from 'lucide-react';
import type { ComboSet } from '@favornoms/database/queries';

/** The photo of each dish in the combo: the view's own when it carries one, else the menu's. */
export function comboDishImages(
  combo: ComboSet,
  itemImageById: ReadonlyMap<string, string | null>,
): string[] {
  const seen = new Set<string>();
  for (const it of combo.items) {
    const url = it.item_image_url || itemImageById.get(it.menu_item_id) || null;
    if (url) seen.add(url);
  }
  return [...seen].slice(0, 4);
}

/**
 * A combo's picture, filling its (relatively positioned) parent.
 *
 * A combo with no photo of its own used to fall back to a food emoji on the branch gradient on
 * the storefront, and to a blank gradient here -- so Food Thai Thai's Family Meal was a burger on
 * one screen and nothing on the other. Without a photo, the till now shows the dishes that are
 * in it, side by side, and a plain box icon when none of them has a photo either.
 */
export function ComboArt({
  combo,
  dishImages,
  sizes,
}: {
  combo: ComboSet;
  dishImages: string[];
  sizes: string;
}) {
  if (combo.image_url) {
    return <Image src={combo.image_url} alt={combo.name} fill sizes={sizes} className="object-cover" />;
  }
  if (dishImages.length === 0) {
    return (
      <div className="bg-muted absolute inset-0 grid place-items-center" aria-hidden>
        <Package className="text-muted-foreground h-10 w-10" strokeWidth={1.5} />
      </div>
    );
  }
  const quad = dishImages.length >= 3;
  return (
    <div
      className={`bg-muted absolute inset-0 grid gap-0.5 ${quad ? 'grid-cols-2 grid-rows-2' : dishImages.length === 2 ? 'grid-cols-2' : ''}`}
      aria-hidden
    >
      {dishImages.map((src, i) => (
        <div
          key={src}
          // Three photos: the first takes the whole left column.
          className={`relative overflow-hidden ${quad && dishImages.length === 3 && i === 0 ? 'row-span-2' : ''}`}
        >
          <Image src={src} alt="" fill sizes={sizes} className="object-cover" />
        </div>
      ))}
    </div>
  );
}
