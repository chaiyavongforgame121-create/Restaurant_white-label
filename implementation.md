# Favornoms — Implementation Guide

> **เอกสารพัฒนาระบบบริหารจัดการร้านอาหารแบบ White-label SaaS**  
> เวอร์ชัน: 1.0 · อัปเดตล่าสุด: 2026-05-25  
> ผู้พัฒนา: [ระบุชื่อทีม]

---

## สารบัญ

1. [Executive Summary](#1-executive-summary)
2. [ขอบเขตและข้อกำหนดของระบบ](#2-ขอบเขตและข้อกำหนดของระบบ)
3. [สถาปัตยกรรมระบบ](#3-สถาปัตยกรรมระบบ)
4. [Tech Stack](#4-tech-stack)
5. [Project Structure (Monorepo)](#5-project-structure-monorepo)
6. [Database Schema](#6-database-schema)
7. [Multi-tenancy Strategy](#7-multi-tenancy-strategy)
8. [Authentication & Authorization](#8-authentication--authorization)
9. [Tenant Resolution & Routing](#9-tenant-resolution--routing)
10. [White-label Theming Engine](#10-white-label-theming-engine)
11. [Driver Dispatch System](#11-driver-dispatch-system)
12. [Module Specifications](#12-module-specifications)
13. [API Design](#13-api-design)
14. [Security & Privacy](#14-security--privacy)
15. [Roadmap & Sprint Plan](#15-roadmap--sprint-plan)
16. [Subscription & Billing Model](#16-subscription--billing-model)
17. [Testing Strategy](#17-testing-strategy)
18. [Deployment & DevOps](#18-deployment--devops)
19. [Common Pitfalls & Best Practices](#19-common-pitfalls--best-practices)
20. [Future Enhancements](#20-future-enhancements)
21. [Appendix](#21-appendix)

---

## 1. Executive Summary

### 1.1 ภาพรวม

**Favornoms** คือระบบ SaaS แบบ white-label สำหรับร้านอาหาร ที่ให้เจ้าของร้านสามารถสร้างและจัดการสาขาของตัวเองได้ พร้อมระบบบริหารครบวงจรตั้งแต่การรับออเดอร์ ครัว การจัดส่ง ไปจนถึง CRM และ analytics

### 1.2 Value Proposition

- **สำหรับเจ้าของร้าน**: ระบบบริหารร้านอาหารครบทุกอย่างในที่เดียว ไม่ต้องผูกกับ delivery platform รายใหญ่
- **สำหรับลูกค้าร้าน**: สั่งอาหารผ่านเว็บของร้านโดยตรง ได้ promo และ loyalty จากร้านนั้นๆ
- **สำหรับ Driver**: สมัครครั้งเดียว วิ่งงานได้หลายร้าน
- **สำหรับ Platform (เรา)**: รายได้แบบ subscription ที่คาดการณ์ได้ scalable

### 1.3 Business Model

- **Pricing**: Subscription รายเดือนต่อ branch
- **Tier**: 3 ระดับ (Starter / Pro / Enterprise)
- **Target market**: ร้านอาหารขนาดกลางที่มีหลายสาขา

### 1.4 Key Constraints

| ข้อกำหนด | รายละเอียด |
|---------|-----------|
| Customer Isolation | ลูกค้าและ Loyalty Points แยกตามสาขา (ไม่แชร์ข้าม branch) |
| Branch URL | แต่ละสาขามี URL ของตัวเอง ไม่เชื่อมกัน (Phase 1) |
| Driver Approval | Driver pool กลาง แต่ต้อง apply และรอ approve ทุกสาขาแยก |
| Schedule Conflict | Driver schedule ห้ามชนกันข้ามสาขา |
| Layout Customization | แต่ละสาขาจัด layout เมนูได้แตกต่างกัน |

---

## 2. ขอบเขตและข้อกำหนดของระบบ

### 2.1 Phase 1 Modules (16 Modules)

| # | Module | คำอธิบาย | Priority |
|---|--------|---------|----------|
| 1 | Restaurant/Branch Setup | ตั้งค่าร้านและสาขา, multi-branch support | P0 |
| 2 | Role & Permissions | จัดการผู้ใช้และสิทธิ์ (Owner, Manager, Cashier, Kitchen, Driver, Staff) | P0 |
| 3 | System Setup | Delivery zone, QR ordering, printer/KDS, device connection | P0 |
| 4 | AI Menu Import | นำเข้าเมนูจาก PDF/รูปด้วย OCR + AI | P2 |
| 5 | Menu & Stock Management | หมวดหมู่, modifier, combo, stock, recipe, food cost | P0 |
| 6 | Order Channels | Dine-in, Pickup, Delivery, QR Ordering | P0 |
| 7 | POS System | รับออเดอร์, split/merge bill, pre-order, refund/void | P0 |
| 8 | Payment | Card, QR (PromptPay), Cash, manual confirm, payment proof | P0 |
| 9 | Kitchen/KDS | Kitchen display, auto print, routing, queue, ready status | P0 |
| 10 | Delivery Management | Radius, pricing tier, surcharge, scheduled delivery | P1 |
| 11 | Driver System | Registration, online/offline, accept/reject, tracking, proof of delivery | P1 |
| 12 | Customer Experience | Order history, reorder, loyalty, address book, favorites | P1 |
| 13 | Loyalty & Rewards | สะสมแต้ม, แลกรางวัล, ตั๋วร้าน/สาขา, ประวัติการใช้ | P1 |
| 14 | Reports & Dashboard | Sales, branch, menu, delivery, peak-hour analysis | P1 |
| 15 | Notifications | Order, kitchen, driver, push notifications | P0 |
| 16 | Security & System | Role-based access, audit log, backup, SSL, audit | P0 |

**Priority Legend**: P0 = MVP (ต้องมีตั้งแต่ launch), P1 = Phase 1 ส่วนหลัง, P2 = Nice to have

### 2.2 Functional Requirements

#### 2.2.1 สำหรับร้านค้า

- เจ้าของร้านสามารถสร้างและจัดการสาขาเองได้ผ่าน admin panel
- แต่ละสาขาจัด layout เมนูได้อิสระ (grid/list/cards/custom)
- แต่ละสาขามี link/URL เป็นของตัวเอง (path-based เริ่มต้น, custom domain เป็น add-on)
- Customer data, loyalty points แยกตามสาขา (ไม่แชร์)
- ตั้งค่า driver dispatch ได้ (search radius, timeout, max attempts)

#### 2.2.2 สำหรับ Driver

- เป็น mobile app เพื่อ tracking, map, notification, call
- สมัครเข้า platform ครั้งเดียว (KYC), แล้ว apply ต่อสาขา
- ต้องรอแต่ละสาขา approve ก่อนรับงาน
- ตั้ง schedule ของแต่ละสาขาแยกกัน (ห้ามชนกัน)
- Real-time location tracking

#### 2.2.3 สำหรับ Customer

- เข้าผ่าน URL ของแต่ละสาขาเพื่อสั่งอาหาร
- สมัครสมาชิกแยกต่อสาขา
- เก็บ loyalty points แยกต่อสาขา
- มีประวัติการสั่ง, reorder, favorites

### 2.3 Non-functional Requirements

| Aspect | Target |
|--------|--------|
| Availability | 99.9% uptime |
| API Response Time | p95 < 300ms (queries), p99 < 1s |
| Concurrent Users | 10,000 concurrent users per region |
| Order Throughput | 1,000 orders/min peak |
| Data Retention | Transactions 7 ปี, logs 1 ปี, audit ตลอดอายุบัญชี |
| Backup | Daily automated, 30-day retention |
| Recovery | RPO 1h, RTO 4h |
| Languages | TH (primary), EN, จีน (planned) |

---

## 3. สถาปัตยกรรมระบบ

### 3.1 High-Level Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     CLIENT LAYER                            │
├──────────────┬──────────────┬──────────────┬───────────────┤
│ Customer Web │  POS Web     │ Branch Admin │ HQ Dashboard  │
│  (Next.js)   │  (Next.js)   │  (Next.js)   │  (Next.js)    │
└──────┬───────┴──────┬───────┴──────┬───────┴───────┬───────┘
       │              │              │               │
       │     ┌────────┴──────────────┴───────────────┘
       │     │                                       
       │     │        Driver App                     
       │     │    (React Native / Expo)              
       │     │              │                        
       └─────┴──────────────┴────────────────────────┐
                                                     │
        ┌────────────────────────────────────────────▼─────┐
        │           API Gateway / Edge Layer               │
        │   - Tenant Resolution                            │
        │   - Auth Verification                            │
        │   - Rate Limiting                                │
        │   - Cache Layer (Redis/Vercel KV)                │
        └──────────────────┬───────────────────────────────┘
                           │
        ┌──────────────────▼──────────────────────────────┐
        │              Supabase Platform                  │
        ├─────────────────────────────────────────────────┤
        │  PostgREST API + Edge Functions                 │
        │  Realtime (WebSocket)                           │
        │  Auth                                           │
        │  Storage (Logo, photos, receipts)               │
        ├─────────────────────────────────────────────────┤
        │  PostgreSQL 15 + PostGIS                        │
        │  - RLS (Row Level Security)                     │
        │  - Logical Replication                          │
        └─────────────────────────────────────────────────┘
                           │
        ┌──────────────────▼──────────────────────────────┐
        │          External Services                      │
        ├─────────────────────────────────────────────────┤
        │  Payment: Omise / 2C2P / Stripe                 │
        │  SMS: Twilio / SMS-Master                       │
        │  Email: Resend / SendGrid                       │
        │  Maps: Google Maps / Mapbox                     │
        │  E-Tax: ETDA-approved providers                 │
        │  Push: FCM / OneSignal                          │
        └─────────────────────────────────────────────────┘
```

### 3.2 Component Responsibilities

#### Client Apps

| App | Purpose | Tech | Users |
|-----|---------|------|-------|
| `apps/web` | Customer-facing ordering | Next.js 15 (App Router) | End customers |
| `apps/pos` | POS terminal & KDS | Next.js + Tailwind | Cashier, Kitchen |
| `apps/admin` | Restaurant admin | Next.js | Owner, Manager |
| `apps/platform` | Internal platform admin | Next.js | Favornoms team |
| `apps/driver` | Driver mobile app | Expo (React Native) | Drivers |

#### Backend Services

- **Supabase**: หลัก (DB + Auth + Realtime + Storage)
- **Edge Functions**: business logic ที่ต้องการ low-latency, webhook receivers
- **Background Jobs**: Inngest / Trigger.dev สำหรับ scheduled tasks, queue
- **Cache**: Redis (Upstash) / Vercel KV

### 3.3 Data Flow Examples

#### Example 1: Customer placing order

```
1. Customer เข้าเว็บ favornoms.com/r/somtam-shop/silom/menu
2. Middleware resolve tenant → set context (branch_id)
3. Browser fetch /api/menu (Supabase auto-filter ด้วย RLS)
4. Customer add to cart → checkout
5. Edge function สร้าง order + payment intent
6. Payment gateway callback → update order status
7. Realtime push → KDS display
8. (ถ้าเป็น delivery) → trigger driver dispatch
```

#### Example 2: Driver dispatch

```
1. Order status = 'ready_for_delivery'
2. Edge function ค้นหา driver online ใน radius
3. SELECT drivers ORDER BY distance LIMIT 1
4. Push notification → driver app
5. Wait timeout (default 45s)
6. ถ้า accept → assign driver, update order
7. ถ้า reject/no response → increment attempt counter
8. ถ้า attempt >= max (3) → ไป driver ถัดไป
9. ถ้าไม่มี driver → notify branch admin
```

---

## 4. Tech Stack

### 4.1 Frontend

| Layer | Technology | Reason |
|-------|-----------|--------|
| Framework | Next.js 15 (App Router) | SSR/ISR สำคัญสำหรับ SEO หน้าเมนู, RSC ลด JS bundle |
| Language | TypeScript 5+ | Type safety สำหรับโปรเจกต์ขนาดใหญ่ |
| Styling | Tailwind CSS 3+ | Utility-first, ทำ theming ด้วย CSS variables ได้ดี |
| UI Library | shadcn/ui | คุณภาพดี, customizable, ไม่ vendor lock |
| State Management | Zustand + TanStack Query | Lightweight, server state แยกชัดจาก client state |
| Forms | React Hook Form + Zod | Performance + schema validation |
| Tables | TanStack Table | Powerful, headless |
| Charts | Recharts | สำหรับ dashboard |
| Icons | Lucide React | Consistent, lightweight |
| i18n | next-intl | App Router compatible |

### 4.2 Mobile (Driver App)

| Layer | Technology |
|-------|-----------|
| Framework | Expo SDK 51+ (React Native) |
| Navigation | Expo Router |
| Maps | react-native-maps |
| Push | Expo Notifications + FCM |
| Background Location | expo-location (background mode) |
| Offline | TanStack Query + persisted cache |

### 4.3 Backend

| Layer | Technology |
|-------|-----------|
| Database | PostgreSQL 15+ (Supabase) |
| Extensions | PostGIS, pg_trgm, uuid-ossp, pgcrypto |
| API | PostgREST (auto-generated) + custom Edge Functions |
| Auth | Supabase Auth (with custom claims for tenant) |
| Realtime | Supabase Realtime (WebSocket) |
| Storage | Supabase Storage (S3-compatible) |
| Edge Runtime | Deno (Supabase Edge Functions) |
| Background Jobs | Inngest / Trigger.dev |
| Cache | Upstash Redis / Vercel KV |
| Search | Postgres full-text + pg_trgm (Phase 1), Meilisearch (Phase 2) |

### 4.4 DevOps

| Layer | Technology |
|-------|-----------|
| Hosting (Web) | Vercel (Edge Network) |
| Hosting (DB) | Supabase Cloud (เริ่ม) → self-hosted ทีหลังถ้าจำเป็น |
| CI/CD | GitHub Actions |
| Monitoring | Sentry (errors) + Axiom (logs) + Better Stack (uptime) |
| Analytics | PostHog (product) + Plausible (web) |
| Infra as Code | Supabase CLI + Terraform (สำหรับ DNS, CDN) |
| Package Manager | pnpm 9+ |
| Monorepo | Turborepo |

### 4.5 External Services (Thailand-specific)

| Service | Purpose | Provider Options |
|---------|---------|------------------|
| Payment Gateway | Card + QR PromptPay | Omise, 2C2P, GBPrimePay |
| E-Tax Invoice | ใบกำกับภาษีอิเล็กทรอนิกส์ | INET, Frevation, Leceipt |
| SMS OTP | Customer auth | SMS-Master, Twilio, ThaiBulkSMS |
| Maps | Geo, routing | Google Maps Platform / Longdo |
| Address Autocomplete | TH addresses | Longdo Map API |

---

## 5. Project Structure (Monorepo)

### 5.1 Folder Layout

```
favornoms/
├── apps/
│   ├── web/                    # Customer-facing site
│   │   ├── app/                # Next.js App Router
│   │   │   ├── r/[restaurant]/[branch]/
│   │   │   │   ├── menu/
│   │   │   │   ├── cart/
│   │   │   │   ├── checkout/
│   │   │   │   ├── orders/
│   │   │   │   └── account/
│   │   │   └── api/
│   │   ├── components/
│   │   ├── lib/
│   │   ├── middleware.ts
│   │   └── next.config.ts
│   │
│   ├── pos/                    # POS terminal
│   ├── admin/                  # Restaurant admin
│   ├── platform/               # Internal platform admin
│   └── driver/                 # Driver app (Expo)
│
├── packages/
│   ├── database/               # DB types & migrations
│   │   ├── types.ts            # Auto-generated from Supabase
│   │   └── queries/            # Shared query functions
│   │
│   ├── auth/                   # Auth utilities
│   │   ├── server.ts
│   │   ├── client.ts
│   │   └── policies.ts
│   │
│   ├── tenant/                 # Multi-tenant logic
│   │   ├── resolve.ts
│   │   ├── context.tsx
│   │   └── cache.ts
│   │
│   ├── ui/                     # Shared UI components
│   │   ├── components/         # shadcn/ui base
│   │   ├── theme/
│   │   └── icons/
│   │
│   ├── shared/                 # Shared types, utils
│   │   ├── types/
│   │   ├── utils/
│   │   ├── constants/
│   │   └── validators/         # Zod schemas
│   │
│   ├── api/                    # API client / SDK
│   │   ├── client.ts
│   │   └── endpoints/
│   │
│   └── config/                 # Shared configs
│       ├── eslint/
│       ├── typescript/
│       └── tailwind/
│
├── supabase/
│   ├── migrations/             # SQL migrations (timestamp-prefixed)
│   │   ├── 20260101000000_init_foundation.sql
│   │   ├── 20260101000100_menu_module.sql
│   │   └── ...
│   ├── functions/              # Edge Functions
│   │   ├── dispatch-driver/
│   │   ├── process-payment/
│   │   └── send-notification/
│   ├── seed.sql
│   └── config.toml
│
├── tests/
│   ├── rls/                    # RLS isolation tests (สำคัญมาก)
│   ├── e2e/                    # Playwright tests
│   └── load/                   # k6 load tests
│
├── docs/
│   ├── architecture/
│   ├── api/
│   └── runbooks/
│
├── package.json
├── pnpm-workspace.yaml
├── turbo.json
└── README.md
```

### 5.2 Workspace Configuration

**`pnpm-workspace.yaml`**:
```yaml
packages:
  - "apps/*"
  - "packages/*"
```

**`turbo.json`** (key tasks):
```json
{
  "$schema": "https://turbo.build/schema.json",
  "tasks": {
    "build": {
      "dependsOn": ["^build"],
      "outputs": [".next/**", "dist/**"]
    },
    "dev": { "cache": false, "persistent": true },
    "lint": {},
    "test": { "dependsOn": ["^build"] },
    "db:migrate": { "cache": false },
    "db:types": { "outputs": ["packages/database/types.ts"] }
  }
}
```

### 5.3 Naming Conventions

| Type | Convention | Example |
|------|-----------|---------|
| Files (components) | PascalCase | `MenuCard.tsx` |
| Files (utils) | kebab-case | `format-currency.ts` |
| Folders | kebab-case | `menu-management/` |
| DB tables | snake_case plural | `menu_items` |
| DB columns | snake_case | `created_at` |
| Functions (DB) | snake_case | `user_branch_ids()` |
| Env vars | SCREAMING_SNAKE_CASE | `NEXT_PUBLIC_SUPABASE_URL` |
| Types/Interfaces | PascalCase | `TenantContext` |
| React hooks | camelCase with use- | `useTenant` |

---

## 6. Database Schema

### 6.1 Entity Relationship Overview

```
auth.users (Supabase managed)
    │
    ├── restaurants (owned by users)
    │       │
    │       ├── branches
    │       │       │
    │       │       ├── menu_categories
    │       │       │       └── menu_items
    │       │       │               ├── modifiers
    │       │       │               └── inventory_items (recipe)
    │       │       │
    │       │       ├── tables (dine-in)
    │       │       │
    │       │       ├── customers (per-branch!)
    │       │       │       ├── customer_addresses
    │       │       │       └── loyalty_points
    │       │       │
    │       │       ├── orders
    │       │       │       ├── order_items
    │       │       │       ├── payments
    │       │       │       └── deliveries
    │       │       │
    │       │       ├── driver_approvals
    │       │       ├── driver_schedules
    │       │       └── notifications_outbox
    │       │
    │       ├── staff_members
    │       └── subscription
    │
    └── drivers (platform-wide pool)
            └── driver_documents (KYC)
```

### 6.2 Core Tables (Stage 0)

โครงสร้างหลักได้ระบุไว้ในไฟล์ migration `20260101000000_init_foundation.sql`:

- `restaurants` — แบรนด์ร้าน
- `branches` — สาขา (มี geo_location, settings, theme_override)
- `staff_members` — พนักงานในระบบ (role-based)
- `audit_logs` — บันทึกทุกการกระทำสำคัญ

ดูรายละเอียดเต็มในส่วน Appendix A หรือไฟล์ migration

### 6.3 Menu Module Tables

```sql
CREATE TABLE menu_categories (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  branch_id       uuid NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  name            text NOT NULL,
  name_translations jsonb DEFAULT '{}'::jsonb, -- { "en": "Thai Food", "zh": "..." }
  display_order   int NOT NULL DEFAULT 0,
  is_active       boolean NOT NULL DEFAULT true,
  available_hours jsonb,  -- เช่น breakfast เฉพาะ 6:00-10:00
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE menu_items (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  branch_id       uuid NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  category_id     uuid REFERENCES menu_categories(id) ON DELETE SET NULL,
  
  -- Basic info
  name            text NOT NULL,
  name_translations jsonb DEFAULT '{}'::jsonb,
  description     text,
  description_translations jsonb DEFAULT '{}'::jsonb,
  
  -- Pricing
  price           decimal(10,2) NOT NULL CHECK (price >= 0),
  cost            decimal(10,2),  -- ต้นทุน (สำหรับ food cost analysis)
  
  -- Media
  image_url       text,
  image_urls      jsonb DEFAULT '[]'::jsonb,  -- gallery
  
  -- Availability
  is_active       boolean NOT NULL DEFAULT true,
  is_recommended  boolean DEFAULT false,
  is_new          boolean DEFAULT false,
  available_channels text[] DEFAULT ARRAY['dine_in','pickup','delivery','qr'],
  
  -- Inventory
  track_stock     boolean DEFAULT false,
  stock_quantity  int,
  low_stock_threshold int DEFAULT 5,
  
  -- Dietary
  allergens       text[] DEFAULT ARRAY[]::text[],  -- ['peanut','dairy','gluten']
  dietary_tags    text[] DEFAULT ARRAY[]::text[],  -- ['vegan','halal','jay','spicy']
  
  -- Display
  display_order   int DEFAULT 0,
  layout_config   jsonb,  -- สำหรับ custom layout (size, position)
  
  -- SEO (สำหรับ menu page)
  slug            text,
  
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  
  UNIQUE(branch_id, slug)
);

CREATE INDEX idx_menu_items_branch_active 
  ON menu_items(branch_id, is_active) WHERE is_active = true;
CREATE INDEX idx_menu_items_category ON menu_items(category_id);
CREATE INDEX idx_menu_items_search 
  ON menu_items USING gin(name gin_trgm_ops);

-- Modifier Groups (ตัวเลือก เช่น "ระดับความเผ็ด", "ขนาด")
CREATE TABLE modifier_groups (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  branch_id       uuid NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  name            text NOT NULL,
  selection_type  text NOT NULL CHECK (selection_type IN ('single','multiple')),
  is_required     boolean DEFAULT false,
  min_select      int DEFAULT 0,
  max_select      int,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE modifier_options (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  group_id        uuid NOT NULL REFERENCES modifier_groups(id) ON DELETE CASCADE,
  name            text NOT NULL,
  price_delta     decimal(10,2) NOT NULL DEFAULT 0,
  is_default      boolean DEFAULT false,
  display_order   int DEFAULT 0
);

-- Link menu_items กับ modifier_groups (M:M)
CREATE TABLE menu_item_modifiers (
  menu_item_id    uuid NOT NULL REFERENCES menu_items(id) ON DELETE CASCADE,
  modifier_group_id uuid NOT NULL REFERENCES modifier_groups(id) ON DELETE CASCADE,
  display_order   int DEFAULT 0,
  PRIMARY KEY (menu_item_id, modifier_group_id)
);

-- Combo Sets
CREATE TABLE combo_sets (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  branch_id       uuid NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  name            text NOT NULL,
  description     text,
  total_price     decimal(10,2) NOT NULL,
  image_url       text,
  is_active       boolean DEFAULT true
);

CREATE TABLE combo_items (
  combo_id        uuid NOT NULL REFERENCES combo_sets(id) ON DELETE CASCADE,
  menu_item_id    uuid NOT NULL REFERENCES menu_items(id),
  quantity        int NOT NULL DEFAULT 1,
  is_swappable    boolean DEFAULT false,
  swap_group      text,  -- เช่น "drink" — items ที่มี swap_group เดียวกันสลับกันได้
  PRIMARY KEY (combo_id, menu_item_id)
);
```

### 6.4 Order Module Tables

```sql
CREATE TYPE order_status AS ENUM (
  'pending',          -- รอชำระเงิน
  'confirmed',        -- ชำระแล้ว, รอครัวรับ
  'preparing',        -- ครัวกำลังทำ
  'ready',            -- พร้อมเสิร์ฟ/รับ
  'out_for_delivery', -- driver รับไปแล้ว
  'completed',        -- ส่งถึงลูกค้า
  'cancelled',        -- ยกเลิก
  'refunded'          -- คืนเงิน
);

CREATE TYPE order_channel AS ENUM (
  'dine_in', 'pickup', 'delivery', 'qr_ordering'
);

CREATE TABLE orders (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  order_number    text NOT NULL,  -- เลขออเดอร์ที่มนุษย์อ่านได้ เช่น "A-2026-001234"
  branch_id       uuid NOT NULL REFERENCES branches(id),
  
  -- Customer info
  customer_id     uuid REFERENCES customers(id),
  customer_name   text,
  customer_phone  text,
  
  -- Channel & table
  channel         order_channel NOT NULL,
  table_id        uuid REFERENCES tables(id),
  
  -- Status
  status          order_status NOT NULL DEFAULT 'pending',
  status_history  jsonb NOT NULL DEFAULT '[]'::jsonb,  -- audit trail
  
  -- Amounts
  subtotal        decimal(10,2) NOT NULL,
  discount_amount decimal(10,2) NOT NULL DEFAULT 0,
  tax_amount      decimal(10,2) NOT NULL DEFAULT 0,
  delivery_fee    decimal(10,2) NOT NULL DEFAULT 0,
  tip_amount      decimal(10,2) NOT NULL DEFAULT 0,
  total           decimal(10,2) NOT NULL,
  
  -- Promotion
  promo_code      text,
  promo_discount  decimal(10,2) DEFAULT 0,
  
  -- Delivery (ถ้าเป็น delivery)
  delivery_address jsonb,   -- snapshot ของ address ตอนสั่ง
  
  -- Notes
  customer_notes  text,
  kitchen_notes   text,
  
  -- Meta
  source          text,  -- 'web', 'pos', 'qr', 'api'
  device_id       text,
  staff_id        uuid REFERENCES staff_members(id),  -- ถ้ารับจาก POS
  
  created_at      timestamptz NOT NULL DEFAULT now(),
  confirmed_at    timestamptz,
  completed_at    timestamptz,
  
  UNIQUE(branch_id, order_number)
);

CREATE INDEX idx_orders_branch_status 
  ON orders(branch_id, status, created_at DESC);
CREATE INDEX idx_orders_customer ON orders(customer_id);
CREATE INDEX idx_orders_created ON orders(created_at DESC);

CREATE TABLE order_items (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  order_id        uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  menu_item_id    uuid NOT NULL REFERENCES menu_items(id),
  
  -- Snapshot (เผื่อ menu เปลี่ยนทีหลัง)
  item_name       text NOT NULL,
  unit_price      decimal(10,2) NOT NULL,
  quantity        int NOT NULL CHECK (quantity > 0),
  
  -- Modifiers (snapshot เป็น JSON)
  modifiers       jsonb DEFAULT '[]'::jsonb,
  modifier_total  decimal(10,2) DEFAULT 0,
  
  -- Computed
  subtotal        decimal(10,2) NOT NULL,
  
  -- Kitchen routing
  station         text,  -- ส่งครัวไหน (cold, hot, drink, etc.)
  prep_status     text DEFAULT 'pending',
  
  notes           text,
  
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_order_items_order ON order_items(order_id);

CREATE TABLE payments (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  order_id        uuid NOT NULL REFERENCES orders(id),
  branch_id       uuid NOT NULL REFERENCES branches(id),
  
  amount          decimal(10,2) NOT NULL,
  method          text NOT NULL,  -- 'card', 'promptpay', 'cash', 'transfer'
  status          text NOT NULL,  -- 'pending', 'completed', 'failed', 'refunded'
  
  -- Gateway info
  gateway         text,           -- 'omise', '2c2p', 'cash'
  gateway_charge_id text,
  gateway_metadata jsonb,
  
  -- Proof (สำหรับ manual confirm)
  proof_image_url text,
  confirmed_by    uuid REFERENCES staff_members(id),
  confirmed_at    timestamptz,
  
  paid_at         timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);
```

### 6.5 Customer & Loyalty Tables

```sql
-- ⚠️ Customer แยกตาม branch (ตาม requirement)
CREATE TABLE customers (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  branch_id       uuid NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  user_id         uuid REFERENCES auth.users(id),  -- nullable: สมัครหรือ guest
  
  phone           text,
  email           text,
  full_name       text,
  
  -- Profile
  birthday        date,
  gender          text,
  
  -- Preferences
  preferred_language text DEFAULT 'th',
  marketing_consent boolean DEFAULT false,
  
  -- Stats (denormalized for speed)
  total_orders    int DEFAULT 0,
  total_spent     decimal(12,2) DEFAULT 0,
  last_order_at   timestamptz,
  
  created_at      timestamptz NOT NULL DEFAULT now(),
  
  -- ลูกค้าคนเดียวสมัครได้หลาย branch แต่ใน branch เดียวกันใช้ phone ซ้ำไม่ได้
  UNIQUE(branch_id, phone)
);

CREATE INDEX idx_customers_branch_phone ON customers(branch_id, phone);
CREATE INDEX idx_customers_user ON customers(user_id);

CREATE TABLE customer_addresses (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  customer_id     uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  
  label           text,  -- "บ้าน", "ออฟฟิศ"
  address_line1   text NOT NULL,
  address_line2   text,
  district        text,
  province        text,
  postal_code     text,
  
  geo_location    geography(POINT, 4326),
  
  is_default      boolean DEFAULT false,
  delivery_notes  text,  -- "ฝากที่ป้อม", "โทรเมื่อถึง"
  
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE loyalty_points (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  customer_id     uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  branch_id       uuid NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  
  points_balance  int NOT NULL DEFAULT 0,
  lifetime_earned int NOT NULL DEFAULT 0,
  lifetime_spent  int NOT NULL DEFAULT 0,
  
  tier            text DEFAULT 'bronze',  -- bronze, silver, gold, platinum
  tier_expires_at timestamptz,
  
  updated_at      timestamptz NOT NULL DEFAULT now(),
  
  UNIQUE(customer_id, branch_id)  -- ⚠️ แยกตาม branch
);

CREATE TABLE loyalty_transactions (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  customer_id     uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  branch_id       uuid NOT NULL REFERENCES branches(id),
  
  type            text NOT NULL,  -- 'earned', 'redeemed', 'expired', 'adjusted'
  points          int NOT NULL,   -- + earned, - redeemed
  balance_after   int NOT NULL,
  
  reference_type  text,  -- 'order', 'reward', 'manual'
  reference_id    uuid,
  
  description     text,
  expires_at      timestamptz,
  
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_loyalty_tx_customer 
  ON loyalty_transactions(customer_id, created_at DESC);
```

### 6.6 Driver Module Tables

```sql
-- Driver pool กลาง (ไม่ผูกกับ branch)
CREATE TABLE drivers (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id         uuid UNIQUE REFERENCES auth.users(id),
  
  -- Personal info
  full_name       text NOT NULL,
  phone           text NOT NULL UNIQUE,
  email           text,
  national_id     text,  -- เลขบัตรประชาชน (encrypted)
  
  -- Vehicle
  vehicle_type    text,  -- 'motorcycle', 'car', 'bicycle'
  vehicle_plate   text,
  vehicle_brand   text,
  
  -- KYC status
  kyc_status      text NOT NULL DEFAULT 'pending'
    CHECK (kyc_status IN ('pending','verified','rejected','suspended')),
  kyc_verified_at timestamptz,
  
  -- Real-time status
  is_online       boolean NOT NULL DEFAULT false,
  current_location geography(POINT, 4326),
  location_updated_at timestamptz,
  battery_level   int,
  
  -- Performance stats
  total_deliveries int DEFAULT 0,
  cancellation_count int DEFAULT 0,
  average_rating  decimal(3,2),
  
  -- Penalty (auto-managed)
  reject_streak   int DEFAULT 0,  -- ปฏิเสธติดต่อกัน
  cooldown_until  timestamptz,    -- ถ้าปฏิเสธบ่อย → cooldown
  
  -- Bank info (สำหรับ payout, encrypted)
  bank_account_encrypted text,
  
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_drivers_online_location 
  ON drivers USING GIST(current_location) 
  WHERE is_online = true AND kyc_status = 'verified';

-- Driver ต้อง apply ต่อ branch แล้วรอ approve
CREATE TABLE driver_approvals (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  driver_id       uuid NOT NULL REFERENCES drivers(id) ON DELETE CASCADE,
  branch_id       uuid NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  
  status          text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','approved','rejected','suspended')),
  
  applied_at      timestamptz NOT NULL DEFAULT now(),
  reviewed_at     timestamptz,
  reviewed_by     uuid REFERENCES staff_members(id),
  notes           text,
  
  UNIQUE(driver_id, branch_id)
);

CREATE INDEX idx_driver_approvals_branch 
  ON driver_approvals(branch_id, status);

-- Schedule แยกตาม branch (ห้ามชนกัน)
CREATE TABLE driver_schedules (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  driver_id       uuid NOT NULL REFERENCES drivers(id) ON DELETE CASCADE,
  branch_id       uuid NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  
  start_at        timestamptz NOT NULL,
  end_at          timestamptz NOT NULL CHECK (end_at > start_at),
  
  status          text DEFAULT 'scheduled'
    CHECK (status IN ('scheduled','active','completed','cancelled')),
  
  notes           text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  
  -- Constraint: ห้าม schedule ของ driver คนเดียวกันชนกัน
  -- (จะใช้ EXCLUDE constraint ด้วย gist extension)
  EXCLUDE USING gist (
    driver_id WITH =,
    tstzrange(start_at, end_at, '[)') WITH &&
  ) WHERE (status IN ('scheduled','active'))
);

-- Deliveries (link order ↔ driver)
CREATE TABLE deliveries (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  order_id        uuid NOT NULL UNIQUE REFERENCES orders(id),
  branch_id       uuid NOT NULL REFERENCES branches(id),
  driver_id       uuid REFERENCES drivers(id),
  
  -- Status
  status          text NOT NULL DEFAULT 'pending'
    CHECK (status IN (
      'pending', 'dispatching', 'assigned', 'picked_up',
      'in_transit', 'delivered', 'failed', 'cancelled'
    )),
  
  -- Dispatch tracking
  dispatch_attempts int DEFAULT 0,
  dispatch_history jsonb DEFAULT '[]'::jsonb,
  -- [{driver_id, attempted_at, response: 'accept'/'reject'/'timeout', response_at}]
  
  -- Times
  assigned_at     timestamptz,
  picked_up_at    timestamptz,
  delivered_at    timestamptz,
  
  -- Geo
  pickup_location geography(POINT, 4326),
  delivery_location geography(POINT, 4326),
  distance_km     decimal(6,2),
  estimated_duration_min int,
  
  -- Proof
  proof_image_url text,
  customer_signature_url text,
  
  -- Pricing
  delivery_fee    decimal(10,2),
  driver_earnings decimal(10,2),
  surge_multiplier decimal(3,2) DEFAULT 1.0,
  
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_deliveries_driver ON deliveries(driver_id, status);
CREATE INDEX idx_deliveries_branch_status ON deliveries(branch_id, status);
```

### 6.7 Subscription & Billing

```sql
CREATE TYPE subscription_tier AS ENUM ('starter','pro','enterprise');

CREATE TABLE subscriptions (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  restaurant_id   uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  
  tier            subscription_tier NOT NULL DEFAULT 'starter',
  status          text NOT NULL DEFAULT 'trialing'
    CHECK (status IN ('trialing','active','past_due','cancelled','expired')),
  
  -- Billing
  billing_cycle   text NOT NULL DEFAULT 'monthly',
  current_period_start timestamptz NOT NULL,
  current_period_end timestamptz NOT NULL,
  
  -- Counts (สำหรับคิดราคา)
  branch_count    int NOT NULL DEFAULT 1,
  unit_price      decimal(10,2) NOT NULL,
  
  -- Payment
  payment_method_id text,
  next_billing_at timestamptz,
  
  -- Cancellation
  cancel_at_period_end boolean DEFAULT false,
  cancelled_at    timestamptz,
  
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE invoices (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  subscription_id uuid NOT NULL REFERENCES subscriptions(id),
  restaurant_id   uuid NOT NULL REFERENCES restaurants(id),
  
  invoice_number  text NOT NULL UNIQUE,
  amount          decimal(10,2) NOT NULL,
  tax             decimal(10,2) DEFAULT 0,
  total           decimal(10,2) NOT NULL,
  
  status          text NOT NULL,  -- 'pending', 'paid', 'failed', 'void'
  
  line_items      jsonb NOT NULL,
  
  due_date        date NOT NULL,
  paid_at         timestamptz,
  
  pdf_url         text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
```

### 6.8 Notifications

```sql
-- Outbox pattern: เก็บ notification ที่จะส่ง
CREATE TABLE notifications_outbox (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  branch_id       uuid REFERENCES branches(id) ON DELETE CASCADE,
  
  -- Target
  recipient_type  text NOT NULL,  -- 'customer', 'staff', 'driver'
  recipient_id    uuid NOT NULL,
  
  -- Channel
  channel         text NOT NULL,  -- 'push', 'sms', 'email', 'in_app'
  
  -- Content
  template        text NOT NULL,  -- 'order_confirmed', 'driver_assigned', etc.
  variables       jsonb DEFAULT '{}'::jsonb,
  
  -- Status
  status          text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','sending','sent','failed','skipped')),
  attempts        int DEFAULT 0,
  last_error      text,
  
  -- Times
  scheduled_for   timestamptz NOT NULL DEFAULT now(),
  sent_at         timestamptz,
  
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_notifications_pending 
  ON notifications_outbox(scheduled_for) 
  WHERE status = 'pending';
```

---

## 7. Multi-tenancy Strategy

### 7.1 ตัวเลือกและการตัดสินใจ

**เลือก: Shared Database + Row-Level Security (RLS)**

| Strategy | ข้อดี | ข้อเสีย | เลือก? |
|----------|------|---------|--------|
| Shared DB + RLS | ต้นทุนต่ำ, scale ง่าย, migration ครั้งเดียว, Supabase support | ต้องระวัง policy ให้ดี, queries อาจช้า | ✅ |
| Schema per tenant | Isolation ดีขึ้น | Migration ลำบาก, Postgres limit ~10k schemas | ❌ |
| Database per tenant | Isolation สูงสุด | ต้นทุนสูง, complex ops | ❌ (เก็บไว้สำหรับ enterprise) |

### 7.2 Tenant Hierarchy

```
Tenant (Restaurant) — root tenant
    └── Sub-tenant (Branch) — ทุก operational data ผูกกับระดับนี้
```

### 7.3 RLS Policy Pattern

ทุก table ที่มี `branch_id` ต้องมี policy ดังนี้:

```sql
-- Pattern 1: Staff access (อ่าน/เขียน)
CREATE POLICY "{table}_staff_access" ON {table}
  FOR ALL TO authenticated
  USING (branch_id IN (SELECT user_branch_ids()))
  WITH CHECK (branch_id IN (SELECT user_branch_ids()));

-- Pattern 2: Public read (สำหรับ menu, branch info)
CREATE POLICY "{table}_public_read" ON {table}
  FOR SELECT TO anon
  USING (
    branch_id IN (
      SELECT id FROM branches WHERE is_active = true
    )
    AND is_active = true  -- ถ้า table มีคอลัมน์นี้
  );

-- Pattern 3: Customer read own data
CREATE POLICY "{table}_customer_own" ON {table}
  FOR SELECT TO authenticated
  USING (customer_id = auth.uid());
```

### 7.4 Helper Functions

```sql
-- คืน branch_ids ที่ user เข้าถึงได้
CREATE FUNCTION user_branch_ids() RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER ...;

-- คืน restaurant_ids ที่ user เข้าถึงได้  
CREATE FUNCTION user_restaurant_ids() RETURNS SETOF uuid ...;

-- เช็คว่ามี role อะไรใน branch
CREATE FUNCTION user_has_role_in_branch(branch_id uuid, role staff_role) RETURNS boolean ...;
```

### 7.5 Performance Considerations

- ทุก table หลักมี index บน `(branch_id, ...)` เป็น compound index
- RLS function ใช้ `STABLE` + `SECURITY DEFINER` เพื่อให้ optimizer cache ได้
- Pagination ใช้ keyset (cursor) แทน OFFSET เมื่อข้อมูลเยอะ

---

## 8. Authentication & Authorization

### 8.1 User Types

| Type | Auth Method | Storage |
|------|-------------|---------|
| Restaurant Owner | Email + Password | `auth.users` + `staff_members` (role=owner) |
| Restaurant Staff | Email/Phone + Password | `auth.users` + `staff_members` |
| Customer | Phone OTP (or email) | `auth.users` + `customers` (per-branch) |
| Driver | Phone OTP | `auth.users` + `drivers` |
| Platform Admin | Email + 2FA | `auth.users` + custom claim `is_platform_admin` |

### 8.2 Custom JWT Claims

ฝัง claim เพิ่มใน JWT เพื่อลด DB queries:

```typescript
interface JWTClaims {
  sub: string;                       // user.id
  email?: string;
  phone?: string;
  
  // Custom claims
  user_type: 'customer' | 'staff' | 'driver' | 'platform_admin';
  restaurant_ids?: string[];         // staff: restaurants ที่เข้าได้
  branch_ids?: string[];             // staff: branches ที่เข้าได้
  role?: 'owner'|'manager'|'cashier'|'kitchen'|'staff';
  is_platform_admin?: boolean;
}
```

ใช้ Supabase Auth Hook (Custom Access Token Hook) เพื่อเพิ่ม claims

### 8.3 Permission Matrix

| Action | Owner | Manager | Cashier | Kitchen | Staff |
|--------|-------|---------|---------|---------|-------|
| Create branch | ✅ | ❌ | ❌ | ❌ | ❌ |
| Edit branch settings | ✅ | ✅ | ❌ | ❌ | ❌ |
| Manage menu | ✅ | ✅ | ❌ | ❌ | ❌ |
| Take orders (POS) | ✅ | ✅ | ✅ | ❌ | ✅ |
| Refund/Void | ✅ | ✅ | ⚠️ (with approval) | ❌ | ❌ |
| View reports | ✅ | ✅ | ⚠️ (limited) | ❌ | ❌ |
| Manage staff | ✅ | ⚠️ (lower roles only) | ❌ | ❌ | ❌ |
| Approve drivers | ✅ | ✅ | ❌ | ❌ | ❌ |
| Update order status (kitchen) | ✅ | ✅ | ❌ | ✅ | ❌ |
| Close cash drawer | ✅ | ✅ | ✅ | ❌ | ❌ |

### 8.4 Session Management

- Access Token: 1 hour TTL (Supabase default)
- Refresh Token: 30 days
- POS terminal: Long-lived session token (device-bound) + per-action PIN สำหรับ refund/void
- Driver app: Auto-refresh, force re-auth ถ้าไม่ใช้งาน > 7 วัน

---

## 9. Tenant Resolution & Routing

### 9.1 URL Strategies

**Phase 1 (เริ่มต้น): Path-based**
```
favornoms.com/r/{restaurant_slug}/{branch_slug}/[page]
```

**Phase 1.5: Subdomain**
```
{restaurant_slug}.favornoms.com/{branch_slug}/[page]
```

**Phase 2: Custom Domain (Enterprise tier)**
```
order.somtamzab.com → branches.custom_domain
```

### 9.2 Middleware Logic

ดูใน `apps/web/middleware.ts` (มีไฟล์ตัวอย่างใน Stage 0 deliverables)

**ขั้นตอน:**
1. ตรวจ hostname → ระบุ method (path/subdomain/custom_domain)
2. แกะ slug จาก URL
3. ดู cache → ถ้ามีใช้เลย, ถ้าไม่ query DB
4. ใส่ tenant context ใน headers/cookie
5. Forward to page handler

### 9.3 Caching Strategy

```typescript
// Layer 1: In-memory (Edge function instance)
const memCache = new Map<string, TenantContext>();
const MEM_TTL = 60_000; // 1 min

// Layer 2: Redis (shared across instances)
const redisCache = redis.client();
const REDIS_TTL = 5 * 60; // 5 min

// Layer 3: Database (source of truth)

async function resolveTenant(slug: string) {
  // L1
  if (memCache.has(slug)) return memCache.get(slug);
  
  // L2
  const cached = await redisCache.get(`tenant:${slug}`);
  if (cached) {
    memCache.set(slug, JSON.parse(cached));
    return JSON.parse(cached);
  }
  
  // L3
  const tenant = await db.from('v_branch_with_theme')...;
  
  // Write back
  await redisCache.setex(`tenant:${slug}`, REDIS_TTL, JSON.stringify(tenant));
  memCache.set(slug, tenant);
  
  return tenant;
}
```

### 9.4 Cache Invalidation

ใช้ Postgres trigger + Supabase Webhook:
```sql
-- เมื่อ branch update → invoke webhook ที่ลบ cache
CREATE TRIGGER branch_cache_invalidate
AFTER UPDATE ON branches
FOR EACH ROW EXECUTE FUNCTION supabase_functions.http_request(
  'POST',
  'https://[edge-fn-url]/invalidate-tenant-cache',
  ...
);
```

---

## 10. White-label Theming Engine

### 10.1 Theme Schema

```typescript
interface TenantTheme {
  // Identity
  logo_url?: string;
  logo_dark_url?: string;
  favicon_url?: string;
  brand_name?: string;
  
  // Colors
  primary_color?: string;      // CTA buttons, accents
  secondary_color?: string;
  accent_color?: string;
  background_color?: string;
  text_color?: string;
  
  // Typography
  font_family?: string;        // Google Fonts name
  font_family_heading?: string;
  
  // Layout
  border_radius?: string;
  menu_layout?: 'grid' | 'list' | 'cards' | 'magazine';
  
  // Hero
  hero_image_url?: string;
  hero_title?: string;
  hero_subtitle?: string;
  
  // Footer
  social_links?: { facebook?: string; instagram?: string; line?: string };
  contact_info?: { phone?: string; email?: string; address?: string };
  
  // Advanced (Enterprise only)
  custom_css?: string;
}
```

### 10.2 Theme Resolution

```typescript
// merge restaurant.brand_settings + branch.theme_override
const resolved = { ...restaurant.brand_settings, ...branch.theme_override };
```

### 10.3 Applying Theme

**Method 1: CSS Variables (recommended)**

```tsx
<div style={{
  '--color-primary': theme.primary_color,
  '--color-secondary': theme.secondary_color,
  '--font-family': theme.font_family,
  '--border-radius': theme.border_radius,
}}>
  {children}
</div>
```

**Tailwind config:**
```ts
colors: {
  primary: 'var(--color-primary)',
  secondary: 'var(--color-secondary)',
}
```

### 10.4 Layout Editor

Phase 1 ให้ผู้ใช้เลือก preset layout 3-4 แบบ:
- **Grid** (3-4 cols ของรูปเมนู)
- **List** (รูปเล็ก + ชื่อ + ราคา)
- **Cards** (รูปใหญ่ + รายละเอียด)
- **Magazine** (featured ใหญ่ + grid เล็ก)

Phase 2+ ค่อยทำ drag-and-drop builder

### 10.5 Asset Storage

- ใช้ Supabase Storage bucket `branch-assets`
- Path: `{branch_id}/logo.png`, `{branch_id}/hero.jpg`
- CDN: Supabase Storage + Cloudflare/Vercel image optimization
- Max file size: 5MB, ผ่าน image optimization

---

## 11. Driver Dispatch System

### 11.1 Algorithm Overview

```
Order ready for delivery
    ↓
Find candidate drivers
    - online = true
    - kyc verified
    - approved for this branch
    - within search_radius_km
    - no cooldown
    - active schedule (if branch enforces schedule)
    ↓
Sort by distance ASC
    ↓
[Loop] Send dispatch to next driver
    ↓
Wait timeout (configurable, default 45s)
    ↓
Response?
    - Accept → assign, break loop
    - Reject → mark, next driver
    - Timeout → count as no-response, next driver
    ↓
After max_attempts (3 default) → fallback
    - Notify branch admin
    - Option: expand search radius
    - Option: keep retrying
```

### 11.2 Settings (per branch)

```jsonb
{
  "driver_search_radius_km": 3,
  "driver_search_max_radius_km": 10,
  "driver_dispatch_timeout_seconds": 45,
  "driver_max_attempts": 3,
  "driver_batch_dispatch_enabled": false,
  "driver_batch_size": 1,
  "driver_expand_radius_on_failure": true,
  "driver_reject_cooldown_minutes": 15,
  "driver_no_response_cooldown_minutes": 30
}
```

### 11.3 Geo Query

```sql
-- หา driver ที่ online + อยู่ในรัศมี + เรียงตามระยะ
SELECT 
  d.id,
  d.full_name,
  d.current_location,
  ST_Distance(d.current_location, b.geo_location) / 1000 AS distance_km
FROM drivers d
JOIN driver_approvals da ON da.driver_id = d.id AND da.branch_id = $branch_id
JOIN branches b ON b.id = $branch_id
WHERE d.is_online = true
  AND d.kyc_status = 'verified'
  AND da.status = 'approved'
  AND (d.cooldown_until IS NULL OR d.cooldown_until < now())
  AND ST_DWithin(
    d.current_location, 
    b.geo_location, 
    ($radius_km * 1000)::float
  )
  AND NOT EXISTS (
    -- ไม่ถูก dispatch ออเดอร์อื่นอยู่
    SELECT 1 FROM deliveries del 
    WHERE del.driver_id = d.id 
      AND del.status IN ('assigned','picked_up','in_transit')
  )
ORDER BY ST_Distance(d.current_location, b.geo_location) ASC
LIMIT 10;
```

### 11.4 Implementation (Edge Function)

```typescript
// supabase/functions/dispatch-driver/index.ts
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';

serve(async (req) => {
  const { order_id } = await req.json();
  
  // 1. Get order + branch settings
  const order = await getOrder(order_id);
  const settings = order.branch.settings;
  const maxAttempts = settings.driver_max_attempts || 3;
  const timeout = settings.driver_dispatch_timeout_seconds || 45;
  
  // 2. Create delivery record
  const delivery = await createDelivery(order);
  
  let radius = settings.driver_search_radius_km;
  const maxRadius = settings.driver_search_max_radius_km;
  
  while (true) {
    // 3. Find candidates
    const candidates = await findCandidates(order.branch_id, radius);
    if (!candidates.length) {
      if (settings.driver_expand_radius_on_failure && radius < maxRadius) {
        radius = Math.min(radius * 1.5, maxRadius);
        continue;
      }
      await notifyBranchAdmin(order, 'no_drivers_available');
      return new Response('No drivers', { status: 503 });
    }
    
    // 4. Try each candidate
    for (const driver of candidates) {
      // Send push
      await sendDispatch(driver.id, delivery.id);
      
      // Wait for response
      const response = await waitForResponse(delivery.id, driver.id, timeout);
      
      // Record attempt
      await recordAttempt(delivery.id, driver.id, response);
      
      if (response === 'accept') {
        await assignDriver(delivery.id, driver.id);
        return new Response(JSON.stringify({ driver_id: driver.id }));
      }
      
      if (response === 'reject') {
        await incrementRejectStreak(driver.id);
      }
      
      if (delivery.dispatch_attempts >= maxAttempts) {
        // Try expanding radius
        if (settings.driver_expand_radius_on_failure && radius < maxRadius) {
          radius = Math.min(radius * 1.5, maxRadius);
          break;
        }
        await notifyBranchAdmin(order, 'max_attempts_reached');
        return new Response('Max attempts', { status: 503 });
      }
    }
  }
});
```

### 11.5 Schedule Conflict Prevention

ใช้ Postgres `EXCLUDE` constraint (ดู section 6.6):
```sql
EXCLUDE USING gist (
  driver_id WITH =,
  tstzrange(start_at, end_at, '[)') WITH &&
) WHERE (status IN ('scheduled','active'))
```

นี่จะป้องกัน schedule ของ driver คนเดียวกันใน 2 branch ที่เวลาทับซ้อนกัน — ถ้าพยายาม insert/update ที่ทับกัน Postgres จะ throw error

**Buffer time:** กำหนด business rule ใน application layer:
```typescript
const MIN_BUFFER_MINUTES = 30;

async function validateScheduleSlot(driverId: string, branchId: string, start: Date, end: Date) {
  // Check existing schedules with buffer
  const conflicts = await db.query(`
    SELECT * FROM driver_schedules
    WHERE driver_id = $1
      AND status IN ('scheduled','active')
      AND (
        -- Schedule ใกล้กันเกินไป
        ABS(EXTRACT(EPOCH FROM (start_at - $3))) < $4
        OR ABS(EXTRACT(EPOCH FROM (end_at - $2))) < $4
      )
  `, [driverId, start, end, MIN_BUFFER_MINUTES * 60]);
  
  if (conflicts.length > 0) {
    throw new Error('Schedule too close to existing slot');
  }
}
```

### 11.6 Penalty System

```typescript
async function handleRejectOrNoResponse(driverId: string, type: 'reject'|'no_response') {
  const driver = await getDriver(driverId);
  driver.reject_streak += 1;
  
  if (driver.reject_streak >= 3) {
    // Cooldown
    const cooldownMin = type === 'reject' ? 15 : 30;
    driver.cooldown_until = new Date(Date.now() + cooldownMin * 60000);
    driver.reject_streak = 0;  // reset
  }
  
  await updateDriver(driver);
}
```

---

## 12. Module Specifications

### 12.1 Module 1: Restaurant/Branch Setup

**Features:**
- Restaurant create/edit (slug, name, owner, brand settings)
- Branch CRUD (สาขาย่อย)
- Open hours (per day, with breaks)
- Service fee setup
- Multi-branch support (สาขาไม่จำกัด)

**Key Endpoints:**
- `POST /api/restaurants` — สร้างร้านใหม่ (เฉพาะ owner)
- `POST /api/restaurants/:id/branches`
- `PATCH /api/branches/:id`
- `GET /api/branches/:id/settings`

### 12.2 Module 2: Role & Permissions

**Roles:** Owner, Manager, Cashier, Kitchen, Driver, Staff

**Invitation Flow:**
1. Owner/Manager ส่ง invitation (email + role + branch)
2. ระบบสร้าง pending `staff_members` + ส่ง email
3. Recipient คลิก link → สมัครหรือ login → ยืนยัน
4. Status เปลี่ยนเป็น active

**Permission Override:** column `permissions jsonb` รับ array ของ permission keys

### 12.3 Module 5: Menu & Stock

ดู section 6.3 สำหรับ schema เต็ม

**สำคัญ:**
- Layout configuration เก็บใน `branches.theme_override.menu_layout`
- Each branch มี menu ของตัวเอง (ไม่ share)
- Modifier groups reusable ใน branch
- Stock decrement อัตโนมัติเมื่อ order confirmed
- Low stock alert → notification ถึง manager

### 12.4 Module 6: Order Channels

**4 Channels:**
1. **Dine-in** — Staff รับออเดอร์ผ่าน POS ผูกกับโต๊ะ
2. **Pickup** — Customer สั่งล่วงหน้า + เลือกเวลา + รับที่ร้าน
3. **Delivery** — Customer สั่ง + driver dispatch
4. **QR Ordering** — Scan QR ที่โต๊ะ → สั่งเอง → ชำระเอง (ไม่ต้องผ่านพนักงาน)

**Order Number Generation:**
```sql
-- รูปแบบ: A-{YYMM}-{seq}  เช่น A-2611-001234
CREATE SEQUENCE order_seq_per_branch_month; 
-- หรือใช้ trigger เพื่อ generate
```

### 12.5 Module 7: POS System

**Key Features:**
- Receipt printer integration (USB/Network/Bluetooth)
- Split bill (แยกบิล), Merge bill (รวมบิล)
- Pre-order/Schedule
- Refund/Void (requires manager PIN)
- Multiple payment methods on single order
- Open tab (เปิดบิลค้าง สำหรับ dine-in)

**Hardware compatibility:**
- ESC/POS printers
- Cash drawer (via printer)
- Customer display (optional)

### 12.6 Module 8: Payment

**Methods:**
- Card (Omise / 2C2P)
- QR PromptPay (Dynamic)
- Cash (manual confirm)
- Bank transfer (manual confirm + upload proof)
- Future: TrueMoney Wallet, LINE Pay

**Flow:**
1. Create payment intent
2. Customer pay
3. Webhook update status
4. Auto-update order status

**E-Tax Invoice:**
- เมื่อ payment success → generate e-tax invoice (async)
- ส่ง email/SMS link ถึงลูกค้า
- เก็บ PDF ใน Supabase Storage

### 12.7 Module 9: Kitchen / KDS

**Display:**
- Realtime via Supabase Realtime
- แยกตาม station (Hot, Cold, Drink, etc.)
- Order routing rule (per menu_item.station)
- Color-code by elapsed time
- "Bump" (กดเสร็จ) → ออเดอร์ไป pickup queue

**Auto Print:**
- ทุก order confirmed → auto print receipt ที่ kitchen printer
- ESC/POS commands
- Retry on failure

### 12.8 Module 10-11: Delivery & Driver

ดู section 11 สำหรับรายละเอียด

### 12.9 Module 12-13: Customer & Loyalty

**Customer Account (per-branch):**
- Sign up via phone OTP
- Same phone สามารถสมัครได้หลาย branch (เป็น customer คนละ record)
- Profile แยกตามแต่ละ branch

**Loyalty:**
- Earn rate: configurable (default 1 บาท = 1 แต้ม)
- Redeem rate: configurable
- Tier system: bronze/silver/gold/platinum (อิงจาก spending 12 เดือน)
- Expire policy: per branch setting

### 12.10 Module 14: Reports & Dashboard

**Reports:**
- Daily/Weekly/Monthly sales
- Sales by menu category/item
- Sales by channel
- Sales by staff
- Peak hour analysis (heatmap)
- Driver performance (deliveries, time, rating)
- Customer cohort analysis
- Food cost vs revenue

**Implementation:**
- Materialized views สำหรับ aggregate queries (refresh ทุกชั่วโมง)
- Real-time dashboard ใช้ direct queries (ระวัง performance)
- Export: CSV, Excel, PDF

### 12.11 Module 15: Notifications

**Types:**
- Order notifications (customer)
- Kitchen notifications (staff)
- Driver notifications (driver app)
- Pickup-ready alerts (customer)
- Status updates
- Marketing (with consent)

**Channels:**
- Push (FCM/OneSignal)
- SMS (Thai-Bulk-SMS / SMS-Master)
- Email (Resend)
- In-app

**Implementation:**
- Outbox pattern (`notifications_outbox`)
- Background worker ดึง pending → ส่ง → mark sent
- Retry with exponential backoff
- Dead letter queue สำหรับ failed messages

### 12.12 Module 16: Security & System

**Role-based Access:** ดู section 8.3

**Audit Log:**
- ทุก write operation ที่สำคัญ → insert into `audit_logs`
- Sensitive operations (refund, void, settings change) → require staff PIN
- View audit log ใน admin panel (filter by time, user, action)

**Backup:**
- Supabase daily automated backup (PITR available)
- Weekly: export ไปเก็บที่ S3 (encrypted)
- Quarterly: test restore

**SSL:**
- Forced HTTPS (HSTS)
- Vercel/Cloudflare auto-renews

---

## 13. API Design

### 13.1 Conventions

- **Base URL**: `/api/v1`
- **Format**: JSON only
- **Auth**: Bearer token (Supabase JWT)
- **Errors**: RFC 7807 Problem Details
- **Pagination**: Cursor-based for lists > 100
- **Versioning**: URI versioning (`/v1/`, `/v2/`)

### 13.2 Resource Endpoints (Examples)

```
# Tenant resolution
GET    /api/v1/tenants/resolve?slug=somtam-shop/silom

# Menu (public)
GET    /api/v1/branches/{branch_id}/menu
GET    /api/v1/branches/{branch_id}/menu/categories
GET    /api/v1/menu-items/{item_id}

# Orders (auth required for customer's own)
POST   /api/v1/orders
GET    /api/v1/orders/{order_id}
PATCH  /api/v1/orders/{order_id}/status

# Driver
POST   /api/v1/drivers/register
POST   /api/v1/drivers/applications     # apply to branch
POST   /api/v1/drivers/location         # update location
POST   /api/v1/drivers/dispatch/respond # accept/reject

# Admin
GET    /api/v1/admin/restaurants
POST   /api/v1/admin/restaurants/{id}/branches
PATCH  /api/v1/admin/branches/{id}
```

### 13.3 Error Response

```json
{
  "type": "https://favornoms.com/errors/insufficient-stock",
  "title": "Insufficient stock",
  "status": 409,
  "detail": "Menu item 'Pad Thai' has only 2 in stock",
  "instance": "/api/v1/orders",
  "extensions": {
    "menu_item_id": "uuid",
    "available_stock": 2,
    "requested": 5
  }
}
```

### 13.4 Rate Limiting

| Endpoint Group | Limit |
|----------------|-------|
| Auth (login, OTP) | 5 req/min/IP |
| Public (menu) | 100 req/min/IP |
| Order creation | 30 req/min/user |
| Admin | 1000 req/min/user |
| Driver location update | 1 req/5sec/driver |

Implementation: Upstash Rate Limit / Cloudflare

---

## 14. Security & Privacy

### 14.1 Data Classification

| Class | Examples | Treatment |
|-------|----------|-----------|
| Public | Menu, branch info | Cacheable, CDN |
| Internal | Reports, staff info | Auth required |
| Confidential | Order details, customer addresses | Auth + RLS |
| Sensitive | Payment info, national_id | Encrypted at rest, never log |

### 14.2 Encryption

- **At rest**: Supabase default (AES-256)
- **In transit**: TLS 1.3
- **Sensitive fields**: pgcrypto for national_id, bank_account
  ```sql
  -- ใช้ pgcrypto
  bank_account_encrypted bytea -- pgp_sym_encrypt(...)
  ```

### 14.3 PII Handling

- Customer phone: required for orders, deletable on request
- National ID (driver KYC): hashed for lookup, encrypted full value
- Address: tied to customer, deletable

### 14.4 PDPA Compliance (Thai personal data protection)

- ✅ Consent forms ตอน sign up
- ✅ Data Processing Agreement template
- ✅ Right to access, edit, delete
- ✅ Breach notification process
- ✅ DPO contact info
- ✅ Privacy policy (Thai + English)

### 14.5 PCI DSS

ไม่เก็บ card data ใน DB เลย — ใช้ tokenization จาก payment gateway:
- Omise: `card_id`, never raw PAN
- Save card: token stored, charge by token

### 14.6 Security Checklist

- [ ] All RLS policies tested with unauthorized user
- [ ] Service role key never in client code
- [ ] Secrets in env vars (not git)
- [ ] Webhooks verify signature
- [ ] CORS strict whitelist
- [ ] CSP headers
- [ ] HSTS enabled
- [ ] Rate limiting on auth endpoints
- [ ] Password requirements: min 12 chars
- [ ] 2FA for owner/platform admin
- [ ] Audit log immutable (no UPDATE/DELETE)
- [ ] Regular dependency updates (Dependabot)
- [ ] Security scanning (Snyk/Socket)
- [ ] Penetration test ก่อน launch

---

## 15. Roadmap & Sprint Plan

### 15.1 Stage 0: Foundation (6 sprints, ~6 weeks)

| Sprint | Goal | Deliverables |
|--------|------|--------------|
| 0.1 | Project setup | Monorepo, Supabase project, CI/CD |
| 0.2 | Auth + RLS | All RLS policies + test suite |
| 0.3 | Tenant routing | Middleware, caching, 404 handling |
| 0.4 | Theming | CSS var system, theme editor (basic) |
| 0.5 | Platform admin | Restaurant/Branch CRUD UI |
| 0.6 | Onboarding | Owner sign-up + setup wizard |

### 15.2 Stage 1: Core Ordering MVP (4 sprints, ~6 weeks)

| Sprint | Goal |
|--------|------|
| 1.1 | Menu management (categories, items, modifiers) |
| 1.2 | POS + order taking |
| 1.3 | Payment (PromptPay + Manual confirm) |
| 1.4 | KDS + receipt printing |

**Milestone:** สามารถขายให้ร้าน dine-in/pickup ได้แล้ว 🎯

### 15.3 Stage 2: Delivery + Driver (4 sprints, ~6 weeks)

| Sprint | Goal |
|--------|------|
| 2.1 | Driver app (basic: register, online/offline) |
| 2.2 | Dispatch algorithm + Edge Function |
| 2.3 | Live tracking + Schedule mgmt |
| 2.4 | Driver earnings + payout |

### 15.4 Stage 3: Customer Experience (3 sprints, ~4 weeks)

| Sprint | Goal |
|--------|------|
| 3.1 | Customer accounts + order history |
| 3.2 | Loyalty system |
| 3.3 | Notifications (all channels) |

### 15.5 Stage 4: Intelligence (3 sprints, ~4 weeks)

| Sprint | Goal |
|--------|------|
| 4.1 | Reports & Dashboard |
| 4.2 | AI Menu Import |
| 4.3 | E-Tax + Multi-language + Polish |

**Total Estimated: ~6-7 months (full-time team of 2-3 devs)**

---

## 16. Subscription & Billing Model

### 16.1 Tiers

| Feature | Starter | Pro | Enterprise |
|---------|---------|-----|------------|
| **Price (THB/branch/month)** | 990-1,490 | 1,990-2,990 | Custom |
| Branches | unlimited | unlimited | unlimited |
| Menu items | 100/branch | unlimited | unlimited |
| Order channels | Dine-in, Pickup, QR | + Delivery | All |
| Customer accounts | ✅ | ✅ | ✅ |
| Loyalty | Basic | Advanced | + Custom rules |
| Driver management | ❌ | ✅ | ✅ |
| Reports | Basic | Advanced | + Custom + Export |
| AI Menu Import | ❌ | 5 imports/month | Unlimited |
| Custom domain | ❌ | ❌ | ✅ |
| Multi-language | TH only | TH, EN | All |
| Support | Email | Email + Chat | Dedicated + SLA |
| Data export | CSV | CSV, Excel | + API access |

### 16.2 Billing Logic

- **Trial**: 14 วัน free (no card required)
- **Billing cycle**: รายเดือน (ตัดทุกวันที่ 1)
- **Proration**: เพิ่ม/ลด branch กลางเดือน → คิด pro-rated
- **Failed payment**: 3 retries (1, 3, 7 days) → suspend
- **Suspend behavior**: 
  - Customer-facing pages ปิด
  - Admin panel เข้าได้ (read-only)
  - 30 วัน → delete data (with warnings)

### 16.3 Payment Methods

- Credit card (Omise / 2C2P)
- Thai bank transfer (manual, 7-day terms)
- Annual prepay (10% discount)

---

## 17. Testing Strategy

### 17.1 Test Pyramid

```
       /\
      /E2E\       <- 10%  (Playwright)
     /------\
    / Integ  \    <- 30%  (API tests, RLS tests)
   /----------\
  /   Unit     \  <- 60%  (Vitest)
 /--------------\
```

### 17.2 Critical Test Suites

**1. RLS Isolation Tests** (ห้ามขาด)
```typescript
// tests/rls/branch-isolation.test.ts
describe('RLS: Branch A staff cannot read Branch B data', () => {
  it('cannot SELECT orders from another branch', async () => {
    const branchAStaff = await loginAs('staff_branch_a');
    const branchBOrders = await branchAStaff
      .from('orders')
      .select()
      .eq('branch_id', BRANCH_B_ID);
    
    expect(branchBOrders.data).toEqual([]);  // RLS hides them
  });
  
  it('cannot INSERT into another branch', async () => {
    const branchAStaff = await loginAs('staff_branch_a');
    const result = await branchAStaff
      .from('orders')
      .insert({ branch_id: BRANCH_B_ID, ... });
    
    expect(result.error).toBeDefined();  // RLS rejects
  });
  
  // ... ทุก table, ทุก operation
});
```

**2. Order Flow E2E**
```typescript
test('Customer can complete order end-to-end', async ({ page }) => {
  await page.goto('/r/somtam-shop/silom/menu');
  await page.click('text=Pad Thai');
  await page.click('text=Add to cart');
  await page.click('text=Checkout');
  // ... full flow until payment success
});
```

**3. Driver Dispatch Tests**
- Single driver scenario
- Multiple drivers, distance sort
- Timeout → next driver
- All reject → notify admin
- Schedule conflict prevention

### 17.3 Load Testing

ใช้ k6:
```javascript
export const options = {
  stages: [
    { duration: '2m', target: 100 },
    { duration: '5m', target: 1000 },
    { duration: '2m', target: 0 },
  ],
};
```

**Targets:**
- 1,000 concurrent users browsing menu: p95 < 300ms
- 100 orders/sec creation: success rate > 99%

---

## 18. Deployment & DevOps

### 18.1 Environments

| Env | URL | DB | Purpose |
|-----|-----|-----|---------|
| Local | localhost | Local Supabase | Dev |
| Dev | dev.favornoms.com | Supabase dev project | Integration |
| Staging | staging.favornoms.com | Supabase staging | Pre-release |
| Production | favornoms.com | Supabase prod | Live |

### 18.2 CI/CD Pipeline

```yaml
# .github/workflows/main.yml
on: [push, pull_request]

jobs:
  lint:    # ESLint, TypeScript, Prettier
  test:    # Unit + Integration
  rls-test: # ⚠️ Critical: Test RLS isolation
  build:   # All apps
  
  deploy-preview:  # on PR
    - Vercel preview URL
    - Comment PR with link
  
  deploy-staging:  # on main
    - Migrate DB
    - Deploy to Vercel staging
    - Run E2E
  
  deploy-prod:  # on tag v*
    - Manual approval required
    - Migrate DB (with backup)
    - Deploy to Vercel prod
    - Smoke tests
    - Notify Slack
```

### 18.3 Database Migrations

- ใช้ Supabase CLI (`supabase migration new`, `supabase db push`)
- Migration ต้อง **idempotent** + **backward compatible** (สำหรับ zero-downtime deploys)
- Schema changes ใหญ่ → run ใน maintenance window

### 18.4 Monitoring & Alerts

| Metric | Tool | Alert Threshold |
|--------|------|-----------------|
| API errors | Sentry | > 1% in 5min |
| API latency | Axiom | p95 > 1s |
| DB connections | Supabase dashboard | > 80% |
| Disk usage | Supabase | > 80% |
| Failed payments | Custom | > 5% |
| Order failure rate | Custom | > 2% |
| Driver dispatch failures | Custom | > 10% |
| Uptime | Better Stack | < 99.5% |

### 18.5 Backup & DR

- **Daily**: Supabase automated backup (7-day retention)
- **PITR**: Point-in-time recovery (last 7 days)
- **Weekly**: Logical export ไป S3 (encrypted, 90-day retention)
- **Quarterly**: Restore test (ใน staging env)

---

## 19. Common Pitfalls & Best Practices

### 19.1 Multi-tenancy

**❌ Don't:**
- Forget RLS on a new table
- Use `service_role` key in user-facing code
- Trust client-sent `branch_id`
- Index without `branch_id` prefix on tenant-scoped tables

**✅ Do:**
- Always test RLS with unauthorized user
- Set `branch_id` from auth context, not request body
- Use compound index: `(branch_id, ...)`
- Add NOT NULL constraint on `branch_id` (except platform-wide tables)

### 19.2 Performance

**❌ Don't:**
- `SELECT *` on large tables
- Run aggregate queries on raw transactions in real-time
- Forget to add indexes on FK columns
- Use OFFSET pagination on large datasets

**✅ Do:**
- Materialized views for reports
- Keyset/cursor pagination
- Cache tenant resolution aggressively
- Use Postgres EXPLAIN ANALYZE on slow queries

### 19.3 Realtime

**❌ Don't:**
- Subscribe to entire tables (e.g., all orders)
- Forget to unsubscribe on component unmount

**✅ Do:**
- Subscribe with filters (`branch_id=eq.xxx`)
- Use channels per branch
- Throttle high-frequency updates (driver location)

### 19.4 Money Handling

**❌ Don't:**
- Use `float` for money
- Calculate totals on client side as source of truth
- Trust client-sent prices

**✅ Do:**
- Use `decimal(10,2)` 
- Recalculate totals server-side
- Store prices snapshot in `order_items` (เผื่อ menu change)

### 19.5 Time Handling

**❌ Don't:**
- Store times without timezone
- Mix `timestamp` and `timestamptz`

**✅ Do:**
- Always `timestamptz`
- Store in UTC, render in user's timezone
- Use `Asia/Bangkok` for Thai business hours logic

---

## 20. Future Enhancements (Post Phase 1)

### Phase 2 Candidates

- **Multi-brand support** — เจ้าของ 1 คนเปิดได้หลายแบรนด์
- **Brand-level loyalty** — แต้มข้ามสาขา (optional setting)
- **AI recommendations** — แนะนำเมนูตาม pattern ลูกค้า
- **Voice ordering** — สั่งผ่านเสียง (Thai voice)
- **Franchise mode** — แชร์เมนู/SOP จาก HQ ลงสาขา
- **Inventory automation** — auto-reorder, supplier integration
- **Reservation system** — full table management
- **Marketing automation** — segmented campaigns
- **Public API** — third-party integrations
- **Mobile app** สำหรับลูกค้า (white-label, ลงทุนเพิ่ม)

---

## 21. Appendix

### A. Glossary

| Term | Definition |
|------|-----------|
| Tenant | ในที่นี้ = Restaurant + Branch (sub-tenant) |
| RLS | Row Level Security — Postgres feature ที่ filter rows ตาม policy |
| KDS | Kitchen Display System — จอแสดงออเดอร์ในครัว |
| POS | Point of Sale — ระบบรับออเดอร์ที่หน้าร้าน |
| KYC | Know Your Customer — กระบวนการยืนยันตัวตน |
| Dispatch | กระบวนการส่งงานให้ driver |
| White-label | ผลิตภัณฑ์ที่ rebrand ได้ตาม customer |
| Edge Function | Serverless function ที่รันใกล้ user |

### B. References

- Supabase Multi-tenant guide: https://supabase.com/docs/guides/auth/managing-user-data
- Postgres RLS: https://www.postgresql.org/docs/current/ddl-rowsecurity.html
- Next.js App Router: https://nextjs.org/docs/app
- PCI DSS Quick Reference: https://www.pcisecuritystandards.org/

### C. Initial Migration Files

See `/supabase/migrations/`:
- `20260101000000_init_foundation.sql` — Restaurants, Branches, Staff, Audit
- `20260101000100_menu_module.sql` — Categories, Items, Modifiers, Combos
- `20260101000200_order_module.sql` — Orders, Order Items, Payments
- `20260101000300_customer_loyalty.sql` — Customers, Loyalty, Addresses
- `20260101000400_driver_module.sql` — Drivers, Approvals, Schedules, Deliveries
- `20260101000500_subscription.sql` — Subscriptions, Invoices
- `20260101000600_notifications.sql` — Notification outbox

### D. Decision Log

| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-05-25 | Shared DB + RLS for multi-tenancy | Cost, scale, Supabase native support |
| 2026-05-25 | Per-branch customer isolation | Per requirement |
| 2026-05-25 | Driver pool centralized | UX for drivers (apply once = profile) |
| 2026-05-25 | Subscription per-branch pricing | Aligns with value delivered |
| 2026-05-25 | Path-based URLs initially | Simplest to deploy, custom domain as add-on |
| 2026-05-25 | Next.js + Supabase stack | Best-in-class DX, faster shipping |

### E. Open Questions

ประเด็นที่ต้องตัดสินใจในระหว่างพัฒนา:

1. ตอน customer สมัครหลาย branch ด้วยเบอร์เดียวกัน → link account หรือแยกเด็ดขาด?
2. Driver earnings: คิดเงินอย่างไร (fixed per delivery / per km / hybrid)?
3. Refund policy: เต็มจำนวน vs partial vs store credit?
4. รูปอาหารจาก AI menu import: เก็บลิขสิทธิ์ใคร?
5. Multi-currency: รองรับเลยใน Phase 1 หรือไม่?

---

## End of Document

**สอบถามเพิ่มเติม / แก้ไข:** [contact info]  
**Repository:** [repo URL]  
**Issue tracker:** [tracker URL]
