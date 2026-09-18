'use client';

import * as React from 'react';

// Every IANA time zone the browser knows, for the Location card and the Add branch dialog.
//
// Both used to offer seven US zones. A branch in Bangkok could only be stored as one of them, so
// Food Thai Thai ran on America/Chicago: its opening hours, happy hour, scheduling windows, 86
// expiry and report days all ticked over twelve hours off. The zone names are IANA identifiers,
// the same in every language, with the current UTC offset alongside so "Asia/Bangkok (GMT+07:00)"
// is recognisable at a glance.

/** Enough to render something before the full list is read, and for a browser without
 *  Intl.supportedValuesOf. */
const FALLBACK_ZONES = [
  'America/Anchorage',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'America/Mexico_City',
  'America/New_York',
  'America/Phoenix',
  'Asia/Bangkok',
  'Asia/Ho_Chi_Minh',
  'Asia/Singapore',
  'Asia/Tokyo',
  'Europe/London',
  'Europe/Madrid',
  'Pacific/Honolulu',
  'UTC',
];

/** The zone this device is set to, or null when the browser will not say. */
export function deviceTimeZone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}

function allTimeZones(): string[] {
  try {
    const supportedValuesOf = (Intl as unknown as { supportedValuesOf?: (key: 'timeZone') => string[] })
      .supportedValuesOf;
    const zones = supportedValuesOf?.('timeZone');
    if (zones && zones.length > 0) return zones;
  } catch {
    /* an older browser: the short list below */
  }
  return FALLBACK_ZONES;
}

/** "GMT+07:00" for the given zone at `at`, or '' when the browser cannot format it. */
function utcOffset(zone: string, at: Date): string {
  try {
    const part = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'longOffset' })
      .formatToParts(at)
      .find((p) => p.type === 'timeZoneName');
    return part?.value ?? '';
  } catch {
    return '';
  }
}

function zoneLabel(zone: string, at: Date): string {
  const offset = utcOffset(zone, at);
  const name = zone.replace(/_/g, ' ');
  return offset ? `${name} (${offset})` : name;
}

export function TimezoneSelect({
  value,
  onChange,
  disabled,
  className,
  id,
}: {
  value: string;
  onChange: (zone: string) => void;
  disabled?: boolean;
  className?: string;
  id?: string;
}) {
  // Read after mount: the server's ICU and the browser's can list slightly different zones, and
  // rendering the list on both would not hydrate.
  const [zones, setZones] = React.useState<Array<{ value: string; label: string }>>([]);
  React.useEffect(() => {
    const now = new Date();
    setZones(allTimeZones().map((zone) => ({ value: zone, label: zoneLabel(zone, now) })));
  }, []);

  const listed = zones.some((z) => z.value === value);
  return (
    <select
      id={id}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      disabled={disabled}
      className={className}
    >
      {/* Whatever is stored stays selectable even when this browser does not list it (an older
          alias such as Asia/Saigon), so opening a screen never silently rewrites the zone. */}
      {!listed && value && (
        <option value={value}>
          {/* The bare name until mounted, so the server and first client render agree. */}
          {zones.length > 0 ? zoneLabel(value, new Date()) : value.replace(/_/g, ' ')}
        </option>
      )}
      {zones.map((z) => (
        <option key={z.value} value={z.value}>
          {z.label}
        </option>
      ))}
    </select>
  );
}
