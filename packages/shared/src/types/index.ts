// Domain types aligned to implementation.md schema. Mock-level for now,
// to be replaced with auto-generated types from Supabase when DB is live.

export type Locale = 'en';

export type LocalizedText = Partial<Record<Locale, string>>;

export interface Restaurant {
  id: string;
  slug: string;
  name: string;
  brandSettings: TenantTheme;
}

export interface Branch {
  id: string;
  restaurantId: string;
  slug: string;
  name: string;
  address: string;
  geoLocation: { lat: number; lng: number };
  themeOverride?: Partial<TenantTheme>;
  settings: BranchSettings;
  isActive: boolean;
}

export interface TenantTheme {
  logoUrl?: string;
  brandName?: string;
  primaryColor?: string;
  secondaryColor?: string;
  accentColor?: string;
  backgroundColor?: string;
  textColor?: string;
  fontFamily?: string;
  borderRadius?: string;
  menuLayout?: 'grid' | 'list' | 'cards' | 'magazine';
  heroImageUrl?: string;
  heroTitle?: LocalizedText;
  heroSubtitle?: LocalizedText;
}

export interface BranchSettings {
  currency: string;
  salesTaxRate?: number;
  deliveryRadiusKm: number;
  driverSearchRadiusKm?: number;
  driverDispatchTimeoutSeconds?: number;
  serviceFeePercent?: number;
  timezone?: string;
}

export interface MenuCategory {
  id: string;
  branchId: string;
  name: string;
  nameTranslations?: LocalizedText;
  displayOrder: number;
  iconEmoji?: string;
}

export type DietaryTag = 'vegan' | 'halal' | 'spicy' | 'gluten-free' | 'new' | 'chef-pick';

export interface MenuItem {
  id: string;
  branchId: string;
  categoryId: string;
  name: string;
  nameTranslations?: LocalizedText;
  description?: string;
  descriptionTranslations?: LocalizedText;
  price: number;
  imageUrl: string | null;
  isRecommended?: boolean;
  isNew?: boolean;
  dietaryTags?: DietaryTag[];
  /** Free-form allergen / ingredient concerns the merchant flags (e.g. "Peanuts", "Shellfish"). */
  allergens?: string[];
  rating?: number;
  reviewCount?: number;
  prepTimeMinutes?: number;
  calories?: number;
  /** When happy hour applies, `price` is the discounted price and `listPrice` is the original. */
  listPrice?: number;
  saleLabel?: string;
  /** True when stock tracking is on and the branch has none left — sold out on the storefront. */
  outOfStock?: boolean;
}

export type OrderChannel = 'dine_in' | 'pickup' | 'delivery' | 'qr_ordering';

export type OrderStatus =
  | 'pending'
  | 'confirmed'
  | 'preparing'
  | 'ready'
  | 'out_for_delivery'
  | 'completed'
  | 'cancelled'
  | 'refunded';

export interface OrderItem {
  menuItemId: string;
  name: string;
  unitPrice: number;
  quantity: number;
  notes?: string;
  imageUrl?: string;
}

export interface Order {
  id: string;
  orderNumber: string;
  branchId: string;
  channel: OrderChannel;
  status: OrderStatus;
  items: OrderItem[];
  subtotal: number;
  deliveryFee: number;
  tax: number;
  total: number;
  customerName?: string;
  customerPhone?: string;
  deliveryAddress?: string;
  createdAt: string;
  estimatedReadyAt?: string;
}

// Driver domain
export type DriverStatus = 'offline' | 'online' | 'on_delivery' | 'cooldown';

export interface Driver {
  id: string;
  fullName: string;
  phone: string;
  vehicleType: 'motorcycle' | 'car' | 'bicycle';
  vehiclePlate: string;
  status: DriverStatus;
  rating: number;
  totalDeliveries: number;
  earningsToday: number;
  earningsWeek: number;
  avatarUrl?: string;
}

export interface Dispatch {
  id: string;
  orderId: string;
  orderNumber: string;
  branchName: string;
  branchAddress: string;
  customerName: string;
  customerAddress: string;
  distanceKm: number;
  estimatedDurationMin: number;
  earnings: number;
  itemsSummary: string;
  timeoutSeconds: number;
  pickupLocation: { lat: number; lng: number };
  dropoffLocation: { lat: number; lng: number };
}
