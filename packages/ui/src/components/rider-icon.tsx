import { Bike, Car, type LucideIcon } from 'lucide-react';

/**
 * What "a delivery / a rider is bringing this" looks like, everywhere in the product.
 *
 * Before this file, fifteen screens each wrote their own `import { Bike } from
 * 'lucide-react'`, so the glyph was fifteen independent decisions that drifted the moment
 * anyone added a screen. Deliveries here are driven, not ridden, so this is a car — and
 * because every screen now reads it from one place, changing it again (to `CarFront`, say)
 * is a one-line change rather than another fifteen-file sweep.
 */
export const RiderIcon: LucideIcon = Car;

/**
 * The same decision for the places that cannot render a React component: Mapbox markers
 * are built out of raw DOM, and HTML email has no SVG we can trust. Keep this in step with
 * RiderIcon — a car on the tracking stepper and a scooter on the pin over it reads as two
 * different deliveries.
 */
export const RIDER_EMOJI = '🚗';

/** Mirrors `drivers_vehicle_type_check` on the live database. */
export type VehicleType = 'motorcycle' | 'car' | 'bicycle';

export function isVehicleType(value: string | null | undefined): value is VehicleType {
  return value === 'motorcycle' || value === 'car' || value === 'bicycle';
}

const VEHICLE_ICON: Record<VehicleType, LucideIcon> = {
  car: Car,
  // lucide 0.468 ships no motorcycle glyph, so a two-wheeler stands in for both. That is
  // the same stand-in every screen used before this file existed, not a new inaccuracy.
  motorcycle: Bike,
  bicycle: Bike,
};

const VEHICLE_EMOJI: Record<VehicleType, string> = {
  car: '🚗',
  motorcycle: '🏍️',
  bicycle: '🚲',
};

/**
 * What ONE rider actually drives — NOT the brand glyph above.
 *
 * `drivers.vehicle_type` is data the rider entered about themselves, and both values are
 * live right now. A screen that also prints that column has to keep agreeing with it;
 * drawing a car next to the literal word "motorcycle" is the product lying about a rider.
 * Falls back to RiderIcon for a value outside the check constraint, because an unreadable
 * row should still say "delivery" rather than render nothing.
 */
export function vehicleTypeIcon(vehicleType: string | null | undefined): LucideIcon {
  return isVehicleType(vehicleType) ? VEHICLE_ICON[vehicleType] : RiderIcon;
}

/** Emoji twin of vehicleTypeIcon, for markers and other DOM-only surfaces. */
export function vehicleTypeEmoji(vehicleType: string | null | undefined): string {
  return isVehicleType(vehicleType) ? VEHICLE_EMOJI[vehicleType] : RIDER_EMOJI;
}
