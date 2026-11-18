import { getBranchIconMetadata } from '@/lib/branch-app-icon';

interface IconLink {
  url: string;
  sizes?: string;
  type?: string;
}

/**
 * The branch's tab icons as <link> elements, rendered by the /b, /counter and /kitchen layouts
 * (branchTabIconsMetadata explains why not through generateMetadata). React hoists them into
 * <head>, and the layout stays mounted across the back office's pages, so they are never taken out
 * and put back while the merchant moves around. Nothing when the branch has no icon of its own:
 * the root layout's FavorNoms icons stay.
 */
export async function BranchTabIcons({ branchId }: { branchId: string }) {
  const icons = (await getBranchIconMetadata(branchId)).icons as
    | { icon?: IconLink[]; apple?: string }
    | null
    | undefined;
  if (!icons) return null;
  return (
    <>
      {(icons.icon ?? []).map((icon) => (
        <link key={icon.url} rel="icon" href={icon.url} sizes={icon.sizes} type={icon.type} />
      ))}
      {icons.apple ? <link rel="apple-touch-icon" href={icons.apple} /> : null}
    </>
  );
}
