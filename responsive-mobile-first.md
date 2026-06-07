# Favornoms — Responsive & Mobile-First Design Guidelines

> **เอกสารกำกับการออกแบบและพัฒนา UI ทุกแอปในระบบ Favornoms**  
> หลักการ: **Mobile-First, ไม่ใช่ Mobile-Only**  
> เวอร์ชัน: 1.0 · อัปเดตล่าสุด: 2026-05-25

---

## สารบัญ

1. [ปรัชญา Mobile-First](#1-ปรัชญา-mobile-first)
2. [Device & Viewport Strategy](#2-device--viewport-strategy)
3. [Breakpoint System](#3-breakpoint-system)
4. [Per-App Device Targets](#4-per-app-device-targets)
5. [Layout Patterns](#5-layout-patterns)
6. [Touch & Interaction](#6-touch--interaction)
7. [Typography & Spacing](#7-typography--spacing)
8. [Navigation Patterns](#8-navigation-patterns)
9. [Forms on Mobile](#9-forms-on-mobile)
10. [Tables & Data on Mobile](#10-tables--data-on-mobile)
11. [Images & Media](#11-images--media)
12. [Performance Budget](#12-performance-budget)
13. [Offline & Network Resilience](#13-offline--network-resilience)
14. [PWA & Native App Strategy](#14-pwa--native-app-strategy)
15. [Accessibility on Mobile](#15-accessibility-on-mobile)
16. [Testing Strategy](#16-testing-strategy)
17. [Tailwind/Code Patterns](#17-tailwindcode-patterns)
18. [Common Pitfalls](#18-common-pitfalls)
19. [Per-App Specific Guidelines](#19-per-app-specific-guidelines)
20. [Checklists](#20-checklists)

---

## 1. ปรัชญา Mobile-First

### 1.1 หลักการพื้นฐาน

**"ออกแบบสำหรับหน้าจอเล็กที่สุดก่อน แล้วค่อย enhance สำหรับจอใหญ่"**

ไม่ใช่ "ทำเดสก์ท็อปก่อนแล้วบีบให้เข้ามือถือ" — แนวทางนั้นจะทำให้ mobile UX แย่เสมอ

### 1.2 ทำไมต้อง Mobile-First สำหรับ Favornoms

| User Type | Device หลัก | % การใช้งาน (ประมาณการ) |
|-----------|------------|------------------------|
| Customer | Smartphone | 85-95% |
| Driver | Smartphone | 100% |
| Cashier | Tablet (มี keyboard บางครั้ง) | 70% tablet, 30% desktop |
| Kitchen | Tablet ขนาดใหญ่ / TV | 80% tablet, 20% TV |
| Branch Manager | Tablet + Laptop | 50:50 |
| Restaurant Owner | Smartphone + Laptop | 60:40 |
| Platform Admin | Desktop เป็นหลัก | 80% desktop |

### 1.3 4 หลักการที่ทีมต้องท่องให้ได้

1. **Touch first, hover second** — ทุก interaction ต้องทำงานได้ด้วยนิ้ว
2. **Thumb zone matters** — ปุ่มสำคัญต้องอยู่ในที่นิ้วโป้งกดถึงได้
3. **Network is unreliable** — เน็ตช้า, หลุด, มือถือบนรถมอเตอร์ไซค์ → ออกแบบเผื่อ
4. **Performance is UX** — โหลดช้า 1 วินาที = สูญลูกค้า

---

## 2. Device & Viewport Strategy

### 2.1 Device Categories ที่ Target

| Category | Viewport Width | ตัวอย่าง |
|----------|---------------|----------|
| Small Mobile | 320–374px | iPhone SE (1st gen) |
| Mobile | 375–413px | iPhone 13/14/15, Pixel |
| Large Mobile | 414–767px | iPhone Pro Max, Galaxy Ultra |
| Small Tablet | 768–1023px | iPad Mini (portrait) |
| Tablet | 1024–1279px | iPad / iPad Air |
| Laptop | 1280–1535px | MacBook Air |
| Desktop | 1536px+ | จอใหญ่, monitor |

### 2.2 Baseline ที่ต้องรองรับ

- **Min width: 320px** (iPhone SE 1st gen — ยังมีคนใช้)
- **Test กับ 375px** (พื้นฐานของ design)
- **Test กับ 768px** (tablet portrait)
- **Test กับ 1024px+** (desktop)

### 2.3 Viewport Meta (สำคัญมาก)

```html
<!-- Web (customer, admin, POS, KDS) -->
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">

<!-- ห้ามใช้ user-scalable=no เพราะ accessibility -->
<!-- ห้าม fix initial-scale ที่ค่าอื่น -->
```

### 2.4 Safe Areas (iPhone notch + bottom indicator)

```css
.app-container {
  padding-top: env(safe-area-inset-top);
  padding-bottom: env(safe-area-inset-bottom);
  padding-left: env(safe-area-inset-left);
  padding-right: env(safe-area-inset-right);
}

/* สำหรับ bottom navigation */
.bottom-nav {
  padding-bottom: max(12px, env(safe-area-inset-bottom));
}
```

---

## 3. Breakpoint System

### 3.1 Tailwind Config

ใช้ default breakpoints ของ Tailwind (เหมาะกับ mobile-first อยู่แล้ว):

```typescript
// tailwind.config.ts
const config = {
  theme: {
    screens: {
      'sm': '640px',     // small tablet
      'md': '768px',     // tablet
      'lg': '1024px',    // laptop  
      'xl': '1280px',    // desktop
      '2xl': '1536px',   // large desktop
    },
  },
};
```

### 3.2 Naming Convention ในโค้ด

```tsx
// ✅ Good: Mobile-first
<div className="p-4 md:p-6 lg:p-8">
  <h1 className="text-2xl md:text-3xl lg:text-4xl">
    Title
  </h1>
</div>

// ❌ Bad: Desktop-first
<div className="p-8 md:p-6 sm:p-4">  
  {/* นี่จะใช้ p-8 เป็น default ซึ่งใหญ่เกินไปบนมือถือ */}
</div>
```

### 3.3 กฎเหล็ก

- **ไม่มี breakpoint = mobile**
- เพิ่ม breakpoint เพื่อ **enhance** เท่านั้น
- ห้ามใช้ `max-width` queries ใน Tailwind (เป็น desktop-first thinking)

---

## 4. Per-App Device Targets

แต่ละ app target ต่างกัน — ออกแบบให้เหมาะกับ device ที่ user จริงจะใช้

### 4.1 Customer Web (`apps/web`)

**Primary:** Mobile (375–414px)  
**Secondary:** Tablet, Desktop  
**Approach:** Mobile-first responsive

**Layout switches:**
- 320–767px → Single column, bottom navigation
- 768–1023px → Two columns (menu + cart sidebar)
- 1024px+ → Three columns optional (categories sidebar + menu + cart)

### 4.2 POS App (`apps/pos`)

**Primary:** Tablet landscape (1024×768)  
**Secondary:** Large tablet, small desktop  
**Approach:** Tablet-first, support mobile (cashier บางครั้งใช้มือถือ)

**Layout:**
- 768px+ landscape → Menu grid (left) + Cart (right) — เคียงกัน
- 768px portrait → Tabbed (Menu tab / Cart tab)
- <768px → Single view, swipe between menu/cart

### 4.3 KDS / Kitchen Display (`apps/pos` + `/kds`)

**Primary:** Large tablet (10-13") หรือ TV (24-43")  
**Secondary:** Smaller tablet  
**Approach:** Tablet-first, optimize สำหรับการดูจากระยะ

- จอใหญ่ → Grid view (3-6 columns)
- จอกลาง → Grid view (2-3 columns)
- จอเล็ก → Single column scroll

**ห้าม support มือถือ** (ไม่ practical, จอเล็กเกิน)

### 4.4 Branch Admin (`apps/admin`)

**Primary:** Laptop (1280–1440px)  
**Secondary:** Tablet, Mobile  
**Approach:** Desktop-first design นโยบาย แต่ทำ responsive ลงมาให้ดี

**Reasoning:** การ config ระบบ, จัดการ menu, ดู report ทำบน desktop เร็วกว่า — แต่ owner/manager ต้องเช็คได้บนมือถือเวลานอกร้าน

**Layout:**
- Desktop → Sidebar nav + main content
- Tablet → Collapsible sidebar
- Mobile → Bottom nav + hamburger menu สำหรับ secondary

### 4.5 Platform Admin (`apps/platform`)

**Primary:** Desktop (1440px+)  
**Approach:** Desktop-first  
**Mobile support:** ระดับ "read-only emergency" — ดูได้, แก้ไขจำกัด

ระบบบริหารภายในของทีม ไม่ต้องเน้น mobile เกินจำเป็น

### 4.6 Driver App (`apps/driver`)

**Primary:** Mobile only (Expo / React Native)  
**Approach:** Native mobile — ไม่ใช่ responsive web

- รองรับ portrait orientation เป็นหลัก
- รองรับ device 4.7" ขึ้นไป (iPhone SE 2 / Android equivalent)
- Optimize สำหรับการใช้ขณะขับรถ (one-tap, large buttons, voice feedback)

---

## 5. Layout Patterns

### 5.1 The 4 Universal Mobile Layouts

#### Pattern A: Stack (single column)
ใช้ทุกที่บนมือถือ — เนื้อหา flow เป็นแนวตั้ง

```tsx
<div className="flex flex-col gap-4 p-4">
  <Header />
  <Content />
  <Footer />
</div>
```

#### Pattern B: Cards Grid
สำหรับ menu items, branch list, product cards

```tsx
<div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
  {items.map(item => <Card key={item.id} {...item} />)}
</div>
```

#### Pattern C: Split View (มือถือ tab, desktop side-by-side)
สำหรับ POS, chat, master-detail

```tsx
{/* Mobile: tab nav */}
<div className="lg:hidden">
  <Tabs>
    <Tab name="menu"><MenuList /></Tab>
    <Tab name="cart"><Cart /></Tab>
  </Tabs>
</div>

{/* Desktop: side-by-side */}
<div className="hidden lg:grid lg:grid-cols-[2fr_1fr] gap-4">
  <MenuList />
  <Cart />
</div>
```

#### Pattern D: Drawer / Sheet
สำหรับ sidebar nav บนมือถือ, modal บนมือถือ

```tsx
{/* Bottom sheet สำหรับ mobile, dialog สำหรับ desktop */}
<Sheet>
  <SheetContent side={isMobile ? 'bottom' : 'right'}>
    {/* content */}
  </SheetContent>
</Sheet>
```

### 5.2 The Container Pattern

```tsx
// packages/ui/components/Container.tsx
export function Container({ children, size = 'default' }) {
  const sizes = {
    sm: 'max-w-screen-sm',     // 640px - reading content
    default: 'max-w-screen-lg', // 1024px - typical page
    lg: 'max-w-screen-xl',      // 1280px - dashboard
    full: 'max-w-full',         // POS, KDS
  };
  
  return (
    <div className={`mx-auto w-full px-4 sm:px-6 lg:px-8 ${sizes[size]}`}>
      {children}
    </div>
  );
}
```

### 5.3 Layout Recommendation per Screen

| Screen | Mobile | Tablet | Desktop |
|--------|--------|--------|---------|
| Customer menu | Stack + bottom nav | 2-col grid | 3-col grid + sidebar |
| Customer cart | Full screen | Slide-over | Sidebar |
| Order tracking | Stack with map top | Map left, info right | Map + sidebar |
| POS order taking | Stack/tabs | Split (menu \| cart) | Split |
| POS payment | Bottom sheet | Modal | Modal |
| KDS | Single column | 2-3 col grid | 4-6 col grid |
| Admin dashboard | Stack cards | 2-col grid | Sidebar + grid |
| Admin tables (data) | Cards (not table!) | Hybrid | Full table |
| Reports | Cards + accordion | Grid | Multi-column |

---

## 6. Touch & Interaction

### 6.1 Touch Target Size

**Minimum: 44×44px** (Apple HIG) / **48×48dp** (Material)  
**Recommended: 48×48px**  
**Critical actions: 56×56px+**

```tsx
// ✅ Good
<button className="min-h-[44px] min-w-[44px] p-3">
  Buy
</button>

// ❌ Bad (too small on mobile)
<button className="h-8 px-2">Buy</button>
```

### 6.2 Spacing Between Touch Targets

ขั้นต่ำ **8px** ระหว่างปุ่ม เพื่อกัน mis-tap

```tsx
// ✅ Good
<div className="flex gap-3">
  <Button>Cancel</Button>
  <Button>Confirm</Button>
</div>
```

### 6.3 Thumb Zone Map

```
┌─────────────────┐
│ ⚠️  Hard reach  │ ← เนื้อหา read-only, header
│                 │
│  🟡 Medium      │
│                 │
│  ✅ Natural     │ ← primary actions
│  ✅ Best        │ ← CTA, bottom nav
└─────────────────┘
```

**กฎ:** Primary action ต้องอยู่ครึ่งล่างของหน้าจอ ไม่ใช่ที่ header

### 6.4 Gestures ที่ใช้ได้และไม่ควรใช้

**✅ ใช้ได้ปลอดภัย:**
- Tap
- Long press (ต้องมี visual feedback ภายใน 500ms)
- Swipe to dismiss (modal, notification)
- Pull to refresh

**⚠️ ใช้ได้แต่ต้องมี alternative:**
- Swipe to delete (ต้องมีปุ่ม delete ด้วย)
- Drag to reorder (ต้องมีปุ่ม up/down)
- Pinch to zoom (ต้องมีปุ่ม +/-)

**❌ หลีกเลี่ยง:**
- Force touch / 3D touch (เลิก support แล้ว)
- Two-finger gestures (ไม่ discoverable)
- Shake to undo

### 6.5 Hover States บนมือถือ

```tsx
// ✅ ใช้ active state สำหรับมือถือ + hover สำหรับ desktop
<button className="
  bg-primary 
  active:bg-primary-dark
  hover:bg-primary-dark
  transition-colors
">
  Click
</button>
```

```css
/* ป้องกัน sticky hover บนมือถือ */
@media (hover: hover) {
  .button:hover { background: var(--primary-dark); }
}
```

### 6.6 Haptic Feedback (Driver app, PWA)

```typescript
// สำหรับ critical actions
if ('vibrate' in navigator) {
  navigator.vibrate(50);  // เบา
}

// Driver app: เมื่อรับ dispatch
navigator.vibrate([200, 100, 200]);  // long-short-long
```

---

## 7. Typography & Spacing

### 7.1 Base Font Size

**Mobile: 16px** (ห้ามต่ำกว่า — iOS จะ zoom เมื่อ focus input)  
**Body: 14-16px**  
**Small text: 12px ขั้นต่ำ**

### 7.2 Type Scale (mobile → desktop)

```typescript
// Tailwind config
fontSize: {
  'xs':   ['12px', { lineHeight: '16px' }],
  'sm':   ['14px', { lineHeight: '20px' }],
  'base': ['16px', { lineHeight: '24px' }],   // body
  'lg':   ['18px', { lineHeight: '28px' }],
  'xl':   ['20px', { lineHeight: '28px' }],
  '2xl':  ['24px', { lineHeight: '32px' }],   // mobile h1
  '3xl':  ['30px', { lineHeight: '36px' }],   // tablet h1
  '4xl':  ['36px', { lineHeight: '40px' }],   // desktop h1
}
```

### 7.3 Heading Hierarchy

```tsx
{/* ✅ Mobile-first heading */}
<h1 className="text-2xl md:text-3xl lg:text-4xl font-bold">
  Page Title
</h1>

<h2 className="text-xl md:text-2xl font-semibold">
  Section
</h2>

<h3 className="text-lg md:text-xl font-semibold">
  Sub-section
</h3>
```

### 7.4 Line Length

- **Mobile**: ใช้ width เต็ม
- **Reading content**: max **65-75 ตัวอักษร** ต่อบรรทัด

```tsx
<article className="max-w-prose mx-auto">
  {/* prose = ~65ch */}
</article>
```

### 7.5 Spacing Scale

ใช้ Tailwind 4-pixel base unit:

```
xs:  0.5rem (8px)   - ระยะภายใน button
sm:  0.75rem (12px) - ระหว่าง elements เล็ก
md:  1rem (16px)    - default spacing
lg:  1.5rem (24px)  - ระหว่าง sections บนมือถือ
xl:  2rem (32px)    - ระหว่าง sections บน tablet
2xl: 3rem (48px)    - ระหว่าง sections บน desktop
```

### 7.6 Thai Typography Considerations

- **Font**: ใช้ `Noto Sans Thai` หรือ `IBM Plex Sans Thai`
- **Line height** ต้องสูงกว่าภาษาอังกฤษ ~10% (เพราะวรรณยุกต์)
- **Font weight**: ไทยควรใช้ 400-500 เป็น body (300 อ่านยาก)

```css
font-family: 'Noto Sans Thai', 'Inter', system-ui, sans-serif;
line-height: 1.6; /* สูงกว่าปกติ */
```

---

## 8. Navigation Patterns

### 8.1 Mobile Navigation Patterns

| Pattern | When to use |
|---------|-------------|
| Bottom Tab Bar | App หลัก, 3-5 sections สูงสุด |
| Hamburger Menu | Secondary nav, มี > 5 sections |
| Tab Bar (top) | Within a section, 2-4 sub-sections |
| Drawer | Hierarchical nav (admin app) |
| Floating Action Button | Primary action ที่ทำบ่อย |

### 8.2 Recommendation per App

#### Customer Web
```
Bottom Tab Bar (mobile) → Top Nav (desktop)
[Menu] [Cart 🛒] [Orders] [Account]
```

#### POS App
```
Side Tab Bar (tablet landscape) → Bottom Tab (mobile/portrait)
[Orders] [Menu] [Tables] [Customers] [Reports]
```

#### Admin App
```
Sidebar (desktop) → Hamburger + Bottom Tab for top 4 (mobile)
[Dashboard] [Orders] [Menu] [More ☰]
```

#### Driver App
```
Bottom Tab Bar (always)
[Home/Online] [Active Order] [History] [Earnings] [Profile]
```

### 8.3 Bottom Navigation Best Practices

```tsx
<nav className="
  fixed bottom-0 left-0 right-0 
  bg-white border-t 
  pb-safe-bottom    /* respect safe area */
  z-50
">
  <div className="grid grid-cols-4 h-16">
    {tabs.map(tab => (
      <button 
        key={tab.id}
        className="
          flex flex-col items-center justify-center
          min-h-[44px] gap-1
          text-xs
        "
      >
        <Icon className="w-6 h-6" />
        <span>{tab.label}</span>
      </button>
    ))}
  </div>
</nav>
```

**กฎเหล็ก:**
- ✅ 3-5 tabs สูงสุด
- ✅ Icon + Label (ไม่ใช่ icon-only)
- ✅ Highlight tab ปัจจุบัน
- ✅ Sticky / Fixed
- ❌ ห้ามใส่ใน iframe หรือ scroll container

### 8.4 Back Navigation

มือถือต้องมี **2 ทาง**:

1. Browser back button / Hardware back (Android)
2. ปุ่ม back ใน UI (มุมบนซ้าย)

```tsx
<header className="flex items-center gap-3 p-4 sticky top-0 bg-white">
  <button onClick={() => router.back()} className="min-h-[44px] min-w-[44px]">
    <ChevronLeft />
  </button>
  <h1 className="text-lg font-semibold">Order Detail</h1>
</header>
```

---

## 9. Forms on Mobile

### 9.1 Input Types ที่ถูกต้อง

```tsx
{/* ✅ Phone number → numeric keyboard */}
<input type="tel" inputMode="tel" autoComplete="tel" />

{/* ✅ Email */}
<input type="email" inputMode="email" autoComplete="email" />

{/* ✅ Number only */}
<input type="text" inputMode="numeric" pattern="[0-9]*" />

{/* ✅ OTP code */}
<input type="text" inputMode="numeric" autoComplete="one-time-code" />

{/* ✅ Date */}
<input type="date" />

{/* ✅ Search */}
<input type="search" />
```

### 9.2 Input Sizing

```tsx
{/* ✅ Good - ป้องกัน iOS zoom (font-size ≥ 16px) */}
<input className="
  w-full
  h-12              /* 48px - touch friendly */
  text-base         /* 16px - no zoom */
  px-4
  rounded-lg
  border
" />
```

### 9.3 Form Layout

```tsx
{/* Mobile-first form */}
<form className="space-y-4">
  <div>
    <label className="block text-sm font-medium mb-1">
      Phone Number
    </label>
    <input
      type="tel"
      className="w-full h-12 text-base px-4 rounded-lg border"
      placeholder="08x-xxx-xxxx"
    />
    <p className="mt-1 text-sm text-gray-500">
      We'll send OTP to this number
    </p>
  </div>
  
  <button className="w-full h-12 bg-primary text-white rounded-lg font-medium">
    Continue
  </button>
</form>
```

### 9.4 Multi-step Forms (Mobile)

แทนที่จะใส่ทุก field ใน 1 หน้า → แบ่งเป็น step

```tsx
<MultiStepForm>
  <Step 1>Personal Info (name, phone)</Step>
  <Step 2>Address</Step>
  <Step 3>Payment</Step>
  <Step 4>Review</Step>
</MultiStepForm>
```

**Progress indicator ที่ดี:**
```tsx
<div className="flex items-center gap-2 mb-4">
  {steps.map((step, i) => (
    <div className={`h-1 flex-1 rounded ${i <= currentStep ? 'bg-primary' : 'bg-gray-200'}`} />
  ))}
</div>
<p className="text-sm text-gray-500">Step {currentStep + 1} of {steps.length}</p>
```

### 9.5 Keyboard Handling

**Auto-focus next input on completion:**
```tsx
// OTP input - 6 boxes
<OTPInput length={6} onComplete={handleSubmit} />
```

**Submit button ต้องไม่โดน keyboard บัง:**
```tsx
{/* ใช้ sticky bottom + viewport units อย่างระวัง */}
<button className="
  fixed bottom-0 left-0 right-0 
  h-14 
  pb-safe-bottom
  bg-primary text-white
">
  Submit
</button>
```

**Dismiss keyboard on scroll:**
```css
/* iOS */
html { -webkit-overflow-scrolling: touch; }
```

---

## 10. Tables & Data on Mobile

### 10.1 ❌ ห้ามใช้ Table แบบเดิม

```tsx
{/* ❌ Bad - scroll horizontal, อ่านยาก */}
<table className="w-full">
  <thead><tr>...</tr></thead>
  <tbody>{rows}</tbody>
</table>
```

### 10.2 ✅ Card Pattern สำหรับ Mobile

```tsx
{/* ✅ Mobile: Cards | Desktop: Table */}
function OrderList({ orders }) {
  return (
    <>
      {/* Mobile view */}
      <div className="md:hidden space-y-3">
        {orders.map(order => (
          <Card key={order.id}>
            <div className="flex justify-between items-start">
              <div>
                <p className="font-semibold">{order.number}</p>
                <p className="text-sm text-gray-500">{order.customer}</p>
              </div>
              <Badge>{order.status}</Badge>
            </div>
            <div className="mt-3 flex justify-between text-sm">
              <span>{order.time}</span>
              <span className="font-semibold">฿{order.total}</span>
            </div>
          </Card>
        ))}
      </div>
      
      {/* Desktop view */}
      <table className="hidden md:table w-full">
        {/* full table */}
      </table>
    </>
  );
}
```

### 10.3 Action Patterns

**Mobile:**
- Tap card → detail view
- Swipe → quick actions (edit, delete) — ต้องมี alternative button
- Long press → context menu

**Desktop:**
- Row hover → show actions
- Click → detail
- Right-click → context menu

### 10.4 Filters & Sort บนมือถือ

```tsx
{/* ❌ ไม่ใช่: filter sidebar (กิน space) */}

{/* ✅ ใช่: bottom sheet หรือ modal */}
<button onClick={() => openFilters()}>
  <FilterIcon /> Filters ({activeFilterCount})
</button>

<BottomSheet>
  <FilterControls />
</BottomSheet>
```

---

## 11. Images & Media

### 11.1 Responsive Images

```tsx
{/* Next.js Image - auto responsive */}
<Image
  src={menuItem.imageUrl}
  alt={menuItem.name}
  width={400}
  height={400}
  sizes="(max-width: 640px) 100vw, 
         (max-width: 1024px) 50vw, 
         33vw"
  priority={isAboveFold}
  className="w-full h-auto rounded-lg"
/>
```

### 11.2 Aspect Ratios

```tsx
{/* ใช้ aspect-ratio แทน fixed height */}
<div className="aspect-square">          {/* 1:1 - menu cards */}
<div className="aspect-[4/3]">           {/* 4:3 - branch photos */}
<div className="aspect-video">           {/* 16:9 - hero, video */}
<div className="aspect-[3/4]">           {/* 3:4 - portrait food */}
```

### 11.3 Image Optimization

- ✅ ใช้ Next.js Image component / Supabase image transform
- ✅ WebP / AVIF format
- ✅ Lazy load below-the-fold
- ✅ Placeholder (blur หรือ skeleton)
- ❌ ห้ามใช้รูปต้นฉบับ 2MB ขึ้น
- ❌ ห้ามใช้ background-image สำหรับ content image

### 11.4 Image Upload (Mobile)

```tsx
<input
  type="file"
  accept="image/*"
  capture="environment"  /* ใช้กล้องหลังโดยตรง สำหรับ menu/proof */
/>
```

**Driver app proof of delivery:**
- Camera direct (no gallery)
- Compress before upload (max 1MB)
- Show progress
- Retry on failure

---

## 12. Performance Budget

### 12.1 Core Web Vitals Targets

| Metric | Mobile Target | Desktop Target |
|--------|--------------|----------------|
| LCP (Largest Contentful Paint) | < 2.5s | < 2.0s |
| FID / INP (Interaction) | < 200ms | < 100ms |
| CLS (Cumulative Layout Shift) | < 0.1 | < 0.1 |
| TTFB (Time to First Byte) | < 600ms | < 400ms |
| Speed Index | < 3.4s | < 2.0s |

### 12.2 Bundle Size Budget

| App | JS Initial | JS Total | CSS |
|-----|-----------|----------|-----|
| Customer web | < 150KB | < 300KB | < 50KB |
| POS | < 250KB | < 500KB | < 80KB |
| Admin | < 300KB | < 600KB | < 100KB |
| KDS | < 100KB | < 200KB | < 30KB |

### 12.3 Techniques

**Code splitting:**
```tsx
// Lazy load heavy components
const Charts = dynamic(() => import('./Charts'), { ssr: false });
const RichTextEditor = dynamic(() => import('./Editor'));
```

**Server Components (Next.js):**
- Default to Server Components
- Use `'use client'` only when needed (forms, interactivity)

**Tree-shaking:**
```tsx
// ❌ Imports entire library
import _ from 'lodash';

// ✅ Imports only what's needed
import debounce from 'lodash/debounce';
```

**Image domains:**
- Customer site: aggressive caching (CDN, 1 year)
- Menu images: stale-while-revalidate

### 12.4 Network-Aware Loading

```tsx
// ลด quality บน slow connection
const connection = navigator.connection;
const isSaveData = connection?.saveData;
const isSlowNetwork = connection?.effectiveType === '2g' || connection?.effectiveType === 'slow-2g';

if (isSaveData || isSlowNetwork) {
  // โหลดรูปขนาดเล็กลง
  // ปิด animations
  // ไม่ pre-fetch
}
```

---

## 13. Offline & Network Resilience

### 13.1 ทำไมสำคัญ

- **ร้านอาหาร** เน็ตหลุดบ่อย (โดยเฉพาะร้านในห้าง basement)
- **Driver** เน็ต 4G ขาดหายในบางพื้นที่
- **Customer** สั่งบนรถไฟ/MRT/BTS

### 13.2 Strategy per App

#### Customer Web — Online-first with cache
- Cache menu (stale-while-revalidate)
- Show cached menu if offline + banner
- ห้าม checkout offline → bring online

#### POS — Offline-first (critical)
- IndexedDB ทุก order, ทุก menu
- Local-first writes → sync เมื่อ online
- Conflict resolution: server wins สำหรับ menu, client wins สำหรับ orders
- Visual indicator (offline/syncing/synced)

#### KDS — Online with auto-reconnect
- WebSocket reconnect logic
- Buffer ของออเดอร์ที่ค้าง
- Audio alert เมื่อ disconnect

#### Driver — Offline-tolerant
- Cache active delivery info
- Queue location updates (send batch when online)
- Allow "mark as delivered" offline → sync later
- Map tiles ใช้ Mapbox offline หรือ Google Maps cached

### 13.3 PWA Service Worker

```typescript
// apps/web/sw.ts
import { precacheAndRoute } from 'workbox-precaching';
import { registerRoute } from 'workbox-routing';
import { CacheFirst, NetworkFirst, StaleWhileRevalidate } from 'workbox-strategies';

// Static assets - cache first
precacheAndRoute(self.__WB_MANIFEST);

// API - network first with fallback
registerRoute(
  /\/api\/.*$/,
  new NetworkFirst({
    cacheName: 'api-cache',
    networkTimeoutSeconds: 3,
  })
);

// Menu images - cache first (long-lived)
registerRoute(
  /\.(?:png|jpg|jpeg|webp|svg)$/,
  new CacheFirst({
    cacheName: 'images',
    plugins: [
      new ExpirationPlugin({ maxEntries: 100, maxAgeSeconds: 30 * 24 * 60 * 60 }),
    ],
  })
);
```

### 13.4 Connection Status UI

```tsx
function ConnectionStatus() {
  const isOnline = useOnlineStatus();
  const isSyncing = useSyncStatus();
  
  if (isOnline && !isSyncing) return null;
  
  return (
    <div className={`fixed top-0 left-0 right-0 z-50 p-2 text-sm text-center ${
      isOnline ? 'bg-blue-500 text-white' : 'bg-yellow-500 text-black'
    }`}>
      {isOnline ? '🔄 Syncing...' : '⚠️ Offline mode'}
    </div>
  );
}
```

---

## 14. PWA & Native App Strategy

### 14.1 PWA หรือ Native?

| App | Recommendation | Reason |
|-----|----------------|--------|
| Customer Web | **PWA** | Reach กว้าง, no install friction |
| POS | **PWA** (with offline) | Cross-platform tablet, install on home screen |
| KDS | **PWA** (full-screen) | TV/tablet, no app store needed |
| Admin | **Responsive Web** | Desktop หลัก, PWA optional |
| Driver | **Native (Expo)** | Background location, push, performance |

### 14.2 PWA Setup (apps/web, apps/pos, apps/kds)

```json
// manifest.json
{
  "name": "Favornoms - [Restaurant Name]",
  "short_name": "Favornoms",
  "description": "Order food online",
  "start_url": "/",
  "display": "standalone",
  "orientation": "portrait",
  "background_color": "#ffffff",
  "theme_color": "#FF6B35",
  "icons": [
    { "src": "/icon-192.png", "sizes": "192x192", "type": "image/png" },
    { "src": "/icon-512.png", "sizes": "512x512", "type": "image/png" },
    { "src": "/icon-maskable.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable" }
  ]
}
```

### 14.3 Install Prompt

```tsx
function InstallPrompt() {
  const [prompt, setPrompt] = useState(null);
  
  useEffect(() => {
    const handler = (e) => {
      e.preventDefault();
      setPrompt(e);
    };
    window.addEventListener('beforeinstallprompt', handler);
    return () => window.removeEventListener('beforeinstallprompt', handler);
  }, []);
  
  if (!prompt) return null;
  
  return (
    <button onClick={() => prompt.prompt()}>
      📲 Install App
    </button>
  );
}
```

### 14.4 KDS Specific - Full-screen Mode

```tsx
async function enterFullscreen() {
  await document.documentElement.requestFullscreen();
  await screen.orientation.lock('landscape').catch(() => {});
}
```

---

## 15. Accessibility on Mobile

### 15.1 Why Accessibility Matters

- ลูกค้าผู้สูงอายุ (ใช้ font ใหญ่)
- ผู้พิการทางสายตา (screen reader)
- ผู้ที่ใช้แสงแดดจ้า (contrast)
- ผู้ที่ฟัง podcast พร้อมใช้ (voice control)

### 15.2 Minimum Requirements (WCAG 2.1 AA)

- **Color contrast**: 4.5:1 สำหรับ text, 3:1 สำหรับ UI
- **Touch target**: 44×44px minimum
- **Focus indicator**: visible focus state
- **Alt text**: ทุกรูปที่มี meaning
- **Labels**: ทุก form field
- **Heading hierarchy**: h1 → h2 → h3 (ไม่ skip)

### 15.3 Code Examples

```tsx
{/* ✅ Accessible button */}
<button
  aria-label="Add Pad Thai to cart"
  aria-pressed={isInCart}
  className="min-h-[44px] focus:ring-2 focus:ring-primary"
>
  <PlusIcon aria-hidden="true" />
  Add
</button>

{/* ✅ Accessible form */}
<label htmlFor="phone">
  Phone Number
  <span aria-label="required">*</span>
</label>
<input
  id="phone"
  type="tel"
  required
  aria-describedby="phone-hint phone-error"
/>
<p id="phone-hint">We'll send OTP</p>
{error && (
  <p id="phone-error" role="alert" className="text-red-500">
    {error}
  </p>
)}
```

### 15.4 Dynamic Type / Font Scaling

User อาจตั้งค่า text size ใหญ่ใน OS:

```css
/* ✅ ใช้ rem, em — scale ตาม user setting */
.text-base { font-size: 1rem; }

/* ❌ ห้ามใช้ px สำหรับ body text */
.text-base { font-size: 16px; }  /* ไม่ scale */
```

### 15.5 Reduce Motion

```css
@media (prefers-reduced-motion: reduce) {
  * {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
  }
}
```

### 15.6 Dark Mode

```tsx
{/* Tailwind dark mode */}
<div className="bg-white dark:bg-gray-900 text-gray-900 dark:text-white">
```

ทุก theme ต้อง support dark mode (ลูกค้านอกบ้านตอนกลางคืน, driver กลางคืน)

---

## 16. Testing Strategy

### 16.1 Physical Devices ที่ควรทดสอบ

**Minimum set:**
- iPhone SE (1st หรือ 2nd gen) — small screen
- iPhone 13/14 — current mainstream
- iPhone Pro Max — large
- Android mid-range (Pixel 4a, Galaxy A series) — performance baseline
- Android flagship (Pixel 8, Galaxy S series)
- iPad Mini — small tablet
- iPad Pro 12.9" — large tablet (KDS)

**Network conditions:**
- 4G regular
- 4G slow (1Mbps)
- 3G (เพื่อ stress test)
- Offline

### 16.2 Browser Coverage

**Must support:**
- Safari iOS 15+ (สำคัญที่สุด — ห้ามแตก)
- Chrome Android 100+
- Chrome Desktop (latest 2 versions)
- Edge Desktop (latest 2 versions)

**Best effort:**
- Firefox (web app, ไม่ใช่ driver app)
- Samsung Internet (Galaxy users)

### 16.3 Testing Tools

**During development:**
- Chrome DevTools — Device Mode
- Safari Web Inspector (สำหรับ iOS Safari)
- BrowserStack / LambdaTest (real device cloud)

**Automated:**
- Playwright (multiple viewports + mobile emulation)
- Lighthouse CI (performance regression)
- axe-core (accessibility)

**Sample Playwright config:**
```typescript
// playwright.config.ts
export default {
  projects: [
    { name: 'iPhone SE', use: devices['iPhone SE'] },
    { name: 'iPhone 14', use: devices['iPhone 14'] },
    { name: 'Pixel 7', use: devices['Pixel 7'] },
    { name: 'iPad Mini', use: devices['iPad Mini'] },
    { name: 'Desktop', use: { viewport: { width: 1280, height: 800 } } },
  ],
};
```

### 16.4 Visual Regression

ใช้ Chromatic / Percy / Playwright screenshots เพื่อจับ visual regression ใน multiple viewports

---

## 17. Tailwind/Code Patterns

### 17.1 Responsive Utility Pattern

```tsx
{/* ✅ Mobile-first, progressive enhancement */}
<div className="
  flex flex-col gap-2     // base (mobile)
  sm:flex-row sm:gap-4    // sm (640px+)
  lg:gap-6                // lg (1024px+)
">
```

### 17.2 Conditional Rendering Pattern

```tsx
{/* ✅ Show/hide by viewport */}
<div className="block md:hidden">Mobile only</div>
<div className="hidden md:block">Desktop only</div>

{/* ✅ Server-side safe alternative */}
import { useMediaQuery } from '@/hooks/useMediaQuery';

function Component() {
  const isMobile = useMediaQuery('(max-width: 767px)');
  // ใช้ในกรณีที่ต้อง logic ต่างกันจริงๆ ไม่ใช่แค่ styling
}
```

### 17.3 Container Queries (modern)

```tsx
{/* สำหรับ component ที่ใส่ใน different layout sizes */}
<div className="@container">
  <div className="
    grid grid-cols-1
    @md:grid-cols-2
    @lg:grid-cols-3
  ">
```

### 17.4 Reusable Hook

```typescript
// hooks/useMediaQuery.ts
export function useMediaQuery(query: string) {
  const [matches, setMatches] = useState(false);
  
  useEffect(() => {
    const media = window.matchMedia(query);
    setMatches(media.matches);
    
    const listener = (e: MediaQueryListEvent) => setMatches(e.matches);
    media.addEventListener('change', listener);
    return () => media.removeEventListener('change', listener);
  }, [query]);
  
  return matches;
}

// hooks/useBreakpoint.ts
export function useBreakpoint() {
  const isMobile = useMediaQuery('(max-width: 767px)');
  const isTablet = useMediaQuery('(min-width: 768px) and (max-width: 1023px)');
  const isDesktop = useMediaQuery('(min-width: 1024px)');
  
  return { isMobile, isTablet, isDesktop };
}
```

### 17.5 Mobile-First Component Pattern

```tsx
// ✅ Good - แต่ละ component สามารถ adapt ตาม layout context
function ProductCard({ product, variant = 'default' }) {
  return (
    <article className={cn(
      'rounded-lg border bg-white overflow-hidden',
      variant === 'compact' && 'flex gap-3',
      variant === 'default' && 'flex flex-col'
    )}>
      <Image
        className={cn(
          'object-cover',
          variant === 'compact' && 'w-24 h-24',
          variant === 'default' && 'aspect-square w-full'
        )}
        src={product.image}
        alt={product.name}
      />
      <div className="p-3 flex-1">
        <h3 className="font-medium">{product.name}</h3>
        <p className="text-sm text-gray-500">฿{product.price}</p>
      </div>
    </article>
  );
}
```

---

## 18. Common Pitfalls

### 18.1 ❌ Don't

| Don't | Why | Do instead |
|-------|-----|------------|
| Use fixed pixel widths | Breaks on small screens | `%`, `rem`, `min/max` |
| Set `font-size: 14px` on inputs | iOS auto-zooms | Use 16px minimum |
| Tiny touch targets (24px) | Hard to tap | 44px minimum |
| Hover-only interactions | No hover on mobile | Add active/focus states |
| `width: 100vw` | Includes scrollbar, overflow | Use `width: 100%` |
| `100vh` for full height | iOS Safari address bar issue | Use `100dvh` or fallback |
| Horizontal scrolling tables | Bad UX on mobile | Use card layout |
| Sidebar nav on mobile | Eats too much space | Bottom nav or drawer |
| Tiny fonts in dark mode | Hard to read | Increase contrast |
| Block content behind modals | Hard to close on mobile | Bottom sheet pattern |

### 18.2 iOS Safari Gotchas

```css
/* ✅ Fix: 100vh ไม่ถูกบน iOS Safari */
.full-height {
  height: 100vh;          /* fallback */
  height: 100dvh;         /* dynamic - ตามแถบที่อยู่ */
}

/* ✅ Fix: Bounce scroll */
body {
  overscroll-behavior: none;
}

/* ✅ Fix: Tap highlight */
* {
  -webkit-tap-highlight-color: transparent;
}

/* ✅ Fix: Date input ไม่ขึ้น native picker */
/* ใช้ <input type="date" /> ตรงๆ ไม่ปรับแต่ง */

/* ✅ Fix: Smooth scrolling */
html {
  scroll-behavior: smooth;
}
```

### 18.3 Android Chrome Gotchas

```css
/* ✅ Fix: Address bar resize issue */
.app-container {
  min-height: 100vh;
  min-height: 100dvh;
}

/* ✅ Fix: Form autofill background */
input:-webkit-autofill {
  -webkit-box-shadow: 0 0 0 1000px white inset;
}
```

---

## 19. Per-App Specific Guidelines

### 19.1 Customer Web — Mobile-First Hard

**Critical screens:**
- Menu — ต้องโหลดเร็ว, สวย, browse ง่าย
- Cart — accessible bottom button always
- Checkout — multi-step, one section per screen
- Order tracking — large status, simple map

**Layout (mobile):**
```
┌─────────────────┐
│ Header (sticky) │  ← logo, language
├─────────────────┤
│ Categories tabs │  ← horizontal scroll
├─────────────────┤
│                 │
│   Menu items    │  ← grid 2 cols
│                 │
├─────────────────┤
│ [Cart 🛒 ฿250] │  ← floating bottom
└─────────────────┘
```

### 19.2 POS — Tablet-First, Mobile Fallback

**Optimal:** iPad Pro 12.9" / Android tablet 11" landscape

**Layout (tablet landscape 1024×768):**
```
┌──────────────┬──────────────┐
│              │              │
│  Menu Grid   │  Current     │
│  (3-4 cols)  │  Order       │
│              │              │
│              │  Total: ฿XX  │
│              │  [Pay]       │
└──────────────┴──────────────┘
```

**Mobile fallback (portrait):**
- Tabs: Menu | Order (ขนาดใหญ่)
- Floating "Pay" button

**Critical UX:**
- One-tap to add item (no popup confirmation)
- Numpad always visible สำหรับ quantity/price
- Quick categories at top (อาหาร, เครื่องดื่ม, ของหวาน)

### 19.3 KDS — TV/Tablet Landscape

**Optimal:** Tablet 11-13" หรือ TV 24-43"

**Layout:**
```
┌────────┬────────┬────────┬────────┐
│ Order  │ Order  │ Order  │ Order  │
│ #001   │ #002   │ #003   │ #004   │
│        │        │        │        │
│ Items  │ Items  │ Items  │ Items  │
│        │        │        │        │
│ [Bump] │ [Bump] │ [Bump] │ [Bump] │
└────────┴────────┴────────┴────────┘
```

**Critical:**
- Font ต้องใหญ่ (อ่านจากระยะ 1-2 เมตร)
- Color coding ชัด (สีตาม urgency)
- Sound alert มาออเดอร์ใหม่
- ไม่ต้อง responsive ลงไปต่ำกว่า tablet (เพราะ use case ไม่มี)

### 19.4 Admin — Desktop-First, Mobile Read-Mostly

**Desktop layout:**
```
┌──────┬───────────────────────────┐
│      │  Top bar (search, profile)│
│ Side ├───────────────────────────┤
│ nav  │                           │
│      │       Content             │
│      │                           │
└──────┴───────────────────────────┘
```

**Mobile layout:**
```
┌─────────────────┐
│ ☰ Title    👤  │  ← header
├─────────────────┤
│                 │
│    Content      │
│                 │
├─────────────────┤
│ [Tabs bottom]   │  ← top 4 sections
└─────────────────┘
```

**Mobile features (limited):**
- ✅ Dashboard view
- ✅ View orders
- ✅ View reports
- ✅ Mark item sold out
- ✅ Approve drivers
- ⚠️ Edit menu (basic only — name, price, sold out)
- ❌ Bulk operations (do on desktop)
- ❌ Complex configuration (do on desktop)

### 19.5 Driver App — Native Mobile

**ทุกอย่างคือ mobile** — ไม่ต้อง responsive

**Key screens:**
- **Home (Online toggle)** — ปุ่มใหญ่ตรงกลาง, ตำแหน่ง map ด้านล่าง
- **Dispatch (incoming)** — Full screen, countdown big, 2 ปุ่ม accept/reject ครึ่งจอ
- **Active delivery** — Map ใหญ่, swipe-up sheet สำหรับ order detail
- **Navigation** — Integrate Google Maps / Apple Maps (deep link หรือ embed)

**Special considerations:**
- **One-handed use** — ผู้ขับใช้มือเดียว → ทุก action ในครึ่งล่างจอ
- **Glove-friendly** — touch targets ใหญ่ (56px+) สำหรับคนใส่ถุงมือ
- **Bright sunlight** — high contrast mode toggle
- **Battery drain** — efficient location updates (5-10s intervals, not 1s)

---

## 20. Checklists

### 20.1 Component Review Checklist

ก่อน merge ทุก component ตรวจ:

- [ ] ทำงานที่ 320px width (iPhone SE 1st gen)
- [ ] ทุก touch target ≥ 44×44px
- [ ] Input ใช้ font-size ≥ 16px
- [ ] Input มี correct `type` และ `inputMode`
- [ ] ปุ่มมี `disabled` state ที่ชัดเจน
- [ ] Loading state รองรับทุก async action
- [ ] Error state แสดงให้ user เห็น
- [ ] Empty state มี (เช่น "ยังไม่มีออเดอร์")
- [ ] Focus indicators visible
- [ ] รองรับ keyboard navigation
- [ ] รองรับ dark mode (ถ้าเปิด)
- [ ] รูปทุกรูปมี alt text
- [ ] ทดสอบบน iOS Safari, Chrome Android
- [ ] ทดสอบ landscape orientation
- [ ] ทดสอบ slow 3G network

### 20.2 Page/Screen Review Checklist

ก่อน release ทุก page ตรวจ:

- [ ] Lighthouse score: Performance > 90, Accessibility > 95
- [ ] LCP < 2.5s บน 4G mobile
- [ ] No CLS issues (จัด layout ก่อน image โหลด)
- [ ] Back navigation ทำงาน (browser back + UI back)
- [ ] Sticky header ไม่บัง content
- [ ] Bottom action button ไม่โดน keyboard บัง
- [ ] Pull-to-refresh ทำงาน (ถ้าเป็น list)
- [ ] Pagination หรือ infinite scroll ทำงานเรียบ
- [ ] รองรับ deep linking (URL บอก state)
- [ ] Share/Copy URL ทำงาน
- [ ] รองรับ offline mode (according to app strategy)
- [ ] Screen reader test (VoiceOver iOS / TalkBack Android)

### 20.3 Pre-Launch Checklist

ก่อน launch แต่ละ app ตรวจ:

- [ ] ทดสอบบน real devices ครบ minimum set
- [ ] PWA manifest + icons ครบ
- [ ] Service worker ทำงาน (สำหรับ apps ที่ตั้งเป็น PWA)
- [ ] Safe area insets ถูกต้อง (iPhone notch)
- [ ] Landscape rotation handled
- [ ] Form autofill ทำงาน
- [ ] Deep links register
- [ ] Open Graph tags สำหรับ share
- [ ] Favicon + apple-touch-icon
- [ ] Analytics tracking ทำงานบน mobile
- [ ] Error tracking ทำงาน (Sentry)
- [ ] User testing กับ target users (อย่างน้อย 3 คน per role)

---

## 21. Tools & Resources

### 21.1 Design Tools

- **Figma** — desktop + mobile artboards (375 × 812, 1280 × 800)
- **Penpot** — open-source alternative
- **Maze** / **Useberry** — user testing on mobile

### 21.2 Development Tools

- **Chrome DevTools** — Device Mode, Network throttling, Lighthouse
- **Safari Web Inspector** — connect iOS device via USB
- **ngrok** — expose localhost ให้ทดสอบบนมือถือจริง
- **Vercel Preview** — auto-generated URLs ทดสอบ PR บนมือถือ

### 21.3 Component Libraries (อ้างอิงดีไซน์)

- **shadcn/ui** — pattern ที่จะใช้ในโปรเจกต์
- **Radix UI** — accessible primitives
- **Headless UI** — accessible primitives
- **Material Web** — สำหรับ pattern reference

### 21.4 Learning Resources

- [web.dev — Mobile](https://web.dev/mobile/)
- [WCAG 2.1 Quick Reference](https://www.w3.org/WAI/WCAG21/quickref/)
- [iOS Human Interface Guidelines](https://developer.apple.com/design/human-interface-guidelines/)
- [Material Design Guidelines](https://m3.material.io/)

---

## 22. Quick Reference Card

> **พิมพ์หน้านี้แปะข้างจอ ทีมทุกคนต้องท่องได้**

### Mobile-First Mantra

1. **Touch ≥ 44px** — ทุกปุ่มกดได้สบาย
2. **Font ≥ 16px** — input ไม่ zoom, body อ่านได้
3. **Mobile-first CSS** — `p-4 md:p-6 lg:p-8` ไม่ใช่กลับด้าน
4. **Primary action ครึ่งล่าง** — thumb-friendly
5. **No hover-only** — touch + click + keyboard
6. **Card > Table** — บนมือถือ
7. **Bottom sheet > Modal** — บนมือถือ
8. **Test 320px** — เสมอ
9. **Offline matters** — เน็ตหลุดได้
10. **Performance is UX** — < 2.5s LCP

### Key Breakpoints

```
< 640px   → Mobile (single column, bottom nav)
≥ 640px   → Small tablet (2-col grids)
≥ 768px   → Tablet (sidebar appears, hybrid layouts)
≥ 1024px  → Laptop (full desktop layout)
≥ 1280px  → Desktop (wide content)
```

### Per-App Quick Reference

| App | Primary | Strategy |
|-----|---------|----------|
| Customer Web | Mobile | Mobile-first PWA |
| POS | Tablet | Tablet-first, mobile fallback |
| KDS | Tablet/TV | Landscape, no mobile |
| Admin | Desktop | Responsive, mobile = read-mostly |
| Driver | Mobile | Native (Expo) |
| Platform | Desktop | Read-only on mobile |

---

## End of Document

**Related Documents:**
- `implementation.md` — System architecture
- `functions-by-role.md` — Feature list per role
- `/packages/ui/` — Shared component library
- Figma file: [link]
- Design system: [link]
