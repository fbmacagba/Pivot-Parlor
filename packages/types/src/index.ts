// @repo/types is the SHARED, frontend-facing contract: camelCase fields shaped
// for UI/API consumption. It is intentionally NOT the database row shape — the
// worker uses its own snake_case `DB*` interfaces in apps/worker/src/db/queries.ts
// (e.g. Booking here uses customerId/price/startTime; the bookings table stores
// customer_name/customer_email/amount/start_time). Keep BookingStatus and the
// status enums in sync with the DB CHECK constraints; the field-name divergence
// is by design, not drift.

// ─── Auth ────────────────────────────────────────────────────────────────────

export type UserRole = "developer" | "admin" | "staff" | "customer";

export interface JWTPayload {
  sub: string;
  role: UserRole;
  shopId?: string;
  exp: number;
  iat: number;
}

export interface User {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  shopId?: string;
  createdAt: string;
}

// ─── Shop ────────────────────────────────────────────────────────────────────

export interface Shop {
  id: string;
  slug: string;
  name: string;
  description: string;
  ownerId: string;
  theme: ShopTheme;
  address?: string;
  phone?: string;
  email?: string;
  logoUrl?: string;
  coverUrl?: string;
  timezone: string;
  currency: string;
  commissionRate: number;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ShopTheme {
  primaryColor: string;
  secondaryColor: string;
  fontFamily: string;
  logoUrl?: string;
  heroText?: string;
  heroSubtext?: string;
}

// ─── Services ────────────────────────────────────────────────────────────────

export interface Service {
  id: string;
  shopId: string;
  name: string;
  description: string;
  durationMinutes: number;
  price: number;
  category: string;
  isActive: boolean;
}

// ─── Staff ───────────────────────────────────────────────────────────────────

export interface StaffMember {
  id: string;
  shopId: string;
  userId: string;
  name: string;
  email: string;
  phone?: string;
  avatarUrl?: string;
  specialties: string[];
  commissionRate?: number;
  isActive: boolean;
}

export interface StaffAvailability {
  staffId: string;
  dayOfWeek: number; // Monday-first: 0=Monday … 6=Sunday (matches the admin schedule editor and the schedules table)
  startTime: string; // "HH:MM"
  endTime: string;
  isAvailable: boolean;
}

// ─── Bookings ────────────────────────────────────────────────────────────────

export type BookingStatus =
  | "pending"
  | "confirmed"
  | "in_progress"
  | "completed"
  | "cancelled"
  | "no_show";

export interface Booking {
  id: string;
  shopId: string;
  customerId: string;
  staffId: string;
  serviceId: string;
  status: BookingStatus;
  startTime: string;
  endTime: string;
  price: number;
  notes?: string;
  createdAt: string;
  updatedAt: string;
}

export interface TimeSlot {
  startTime: string;
  endTime: string;
  staffId: string;
  isAvailable: boolean;
}

// ─── Waitlist ────────────────────────────────────────────────────────────────

export interface WaitlistEntry {
  id: string;
  shopId: string;
  customerId: string;
  serviceId: string;
  preferredDate: string;
  preferredStaffId?: string;
  status: "waiting" | "notified" | "booked" | "expired";
  createdAt: string;
}

// ─── Revenue ─────────────────────────────────────────────────────────────────

export interface RevenueStats {
  totalRevenue: number;
  platformCommission: number;
  shopRevenue: number;
  bookingsCount: number;
  period: "day" | "week" | "month" | "year";
}

// ─── AI / Brand Config ────────────────────────────────────────────────────────

export interface BrandConfig {
  primaryColor: string;
  accentColor: string;
  fontHeading: string;
  fontBody: string;
  tagline: string;
  heroHeadline: string;
  heroSubheadline: string;
  shortDescription: string;
  ctaText: string;
  aestheticKeywords: string[];
  servicesIntro: string;
  trustStatement: string;
  urgencyText: string;
}

export type ModelProvider = "anthropic" | "google";
export type ModelTier = "standard" | "pro" | "premium";

export interface AIModel {
  id: string;
  name: string;
  provider: ModelProvider;
  tier: ModelTier;
  description: string;
  costPer1MInput: number;
  costPer1MOutput: number;
  isPreview: boolean;
  recommended: boolean;
}

// ─── AI Deploy (legacy) ───────────────────────────────────────────────────────

export interface AIDeployRequest {
  shopName: string;
  shopType: "beauty_parlour" | "barber_shop" | "nail_salon" | "spa";
  description: string;
  services: string[];
  targetAudience?: string;
  brandPersonality?: string;
}

export interface AIDeployResult {
  shopId: string;
  slug: string;
  theme: ShopTheme;
  generatedContent: {
    heroText: string;
    heroSubtext: string;
    aboutText: string;
    services: Array<{ name: string; description: string; price: number; durationMinutes: number }>;
  };
}

// ─── API Responses ───────────────────────────────────────────────────────────

export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
}

export interface PaginatedResponse<T> extends ApiResponse<T[]> {
  total: number;
  page: number;
  limit: number;
}
