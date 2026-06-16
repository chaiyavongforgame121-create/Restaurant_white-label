'use client';

// US address input with Mapbox Address Autofill. Loads @mapbox/search-js-react
// lazily inside an effect (SSR-safe) and degrades to a plain text input when
// the token is missing or the library hasn't loaded yet — the form keeps
// working either way; only the suggestions and coordinates disappear.

import * as React from 'react';
import { getMapboxToken } from './token';

export interface ResolvedAddress {
  line1: string;
  line2?: string;
  city?: string;
  state?: string;
  postal_code?: string;
  lat: number;
  lng: number;
}

export interface AddressAutofillInputProps {
  value: string;
  onChange: (text: string) => void;
  /** Fired when the user picks a suggestion — full address + coordinates. */
  onResolved?: (address: ResolvedAddress) => void;
  placeholder?: string;
  className?: string;
  inputClassName?: string;
  disabled?: boolean;
  required?: boolean;
  'aria-label'?: string;
}

// Loose typings for the lazily-imported AddressAutofill component.
type AutofillRetrieveResponse = {
  features?: Array<{
    geometry?: { coordinates?: [number, number] };
    properties?: Record<string, unknown>;
  }>;
};
type AutofillComponent = React.ComponentType<{
  accessToken: string;
  onRetrieve?: (res: AutofillRetrieveResponse) => void;
  children: React.ReactNode;
}>;

export function AddressAutofillInput({
  value,
  onChange,
  onResolved,
  placeholder = 'Street address',
  className,
  inputClassName,
  disabled,
  required,
  ...rest
}: AddressAutofillInputProps) {
  const token = getMapboxToken();
  const [Autofill, setAutofill] = React.useState<AutofillComponent | null>(null);

  React.useEffect(() => {
    if (!token) return;
    let cancelled = false;
    void import('@mapbox/search-js-react').then((mod) => {
      if (!cancelled) setAutofill(() => mod.AddressAutofill as unknown as AutofillComponent);
    });
    return () => {
      cancelled = true;
    };
  }, [token]);

  const handleRetrieve = React.useCallback(
    (res: AutofillRetrieveResponse) => {
      const feature = res.features?.[0];
      const coords = feature?.geometry?.coordinates;
      const props = feature?.properties ?? {};
      if (!coords || coords.length < 2) return;
      const line1 =
        (props.address_line1 as string) ??
        (props.full_address as string) ??
        value;
      const resolved: ResolvedAddress = {
        line1,
        line2: (props.address_line2 as string) || undefined,
        city: (props.address_level2 as string) || (props.place as string) || undefined,
        state: (props.address_level1 as string) || (props.region_code as string) || undefined,
        postal_code: (props.postcode as string) || undefined,
        lng: coords[0],
        lat: coords[1],
      };
      onChange(resolved.line1);
      onResolved?.(resolved);
    },
    [onChange, onResolved, value],
  );

  const input = (
    <input
      type="text"
      autoComplete="address-line1"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      className={inputClassName}
      disabled={disabled}
      required={required}
      {...rest}
    />
  );

  if (!token || !Autofill) {
    return <div className={className}>{input}</div>;
  }
  return (
    <div className={className}>
      <Autofill accessToken={token} onRetrieve={handleRetrieve}>
        {input}
      </Autofill>
    </div>
  );
}
