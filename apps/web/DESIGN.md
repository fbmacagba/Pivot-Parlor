---
name: Pivot Parlor
description: Parlor Gold on Onyx for the platform's own surfaces (marketing, dashboards, the plain booking journey); shop sites run on their own generated theme.
colors:
  parlor-gold: "#C9A84C"
  champagne: "#E2C47A"
  antique-gold: "#A8872E"
  onyx: "#0D0D0D"
  charcoal: "#1a1a1a"
  slate: "#2a2a2a"
  slate-light: "#3a3a3a"
  white: "#ffffff"
  ink-80: "rgba(255,255,255,0.80)"
  ink-70: "rgba(255,255,255,0.70)"
  ink-60: "rgba(255,255,255,0.60)"
  ink-40: "rgba(255,255,255,0.40)"
  line-10: "rgba(255,255,255,0.10)"
  line-20: "rgba(255,255,255,0.20)"
  line-40: "rgba(255,255,255,0.40)"
  fill-5: "rgba(255,255,255,0.05)"
  fill-10: "rgba(255,255,255,0.10)"
  gold-tint-10: "rgba(201,168,76,0.10)"
  gold-tint-20: "rgba(201,168,76,0.20)"
  gold-tint-30: "rgba(201,168,76,0.30)"
  success: "#34d399"
  success-tint: "rgba(16,185,129,0.20)"
  warning: "#fbbf24"
  warning-tint: "rgba(245,158,11,0.20)"
  danger: "#f87171"
  danger-tint: "rgba(239,68,68,0.20)"
  danger-solid: "#dc2626"
typography:
  display:
    fontFamily: "Playfair Display, Georgia, serif"
    fontSize: "3rem"
    fontWeight: 700
    lineHeight: 1.08
  headline:
    fontFamily: "Playfair Display, Georgia, serif"
    fontSize: "2.25rem"
    fontWeight: 700
    lineHeight: 1.25
  title:
    fontFamily: "Playfair Display, Georgia, serif"
    fontSize: "1.25rem"
    fontWeight: 600
  body:
    fontFamily: "DM Sans, system-ui, sans-serif"
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "DM Sans, system-ui, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 500
    lineHeight: 1.25
rounded:
  control: "0.5rem"
  card: "0.75rem"
  dialog: "1rem"
  pill: "9999px"
spacing:
  "1": "0.25rem"
  "2": "0.5rem"
  "3": "0.75rem"
  "4": "1rem"
  "5": "1.25rem"
  "6": "1.5rem"
  "8": "2rem"
  "10": "2.5rem"
components:
  button-primary:
    backgroundColor: "{colors.parlor-gold}"
    textColor: "{colors.onyx}"
    typography: "{typography.label}"
    rounded: "{rounded.control}"
    padding: "0.5rem 1.25rem"
    height: "2.5rem"
  button-primary-hover:
    backgroundColor: "{colors.champagne}"
  button-primary-active:
    backgroundColor: "{colors.antique-gold}"
  button-outline:
    backgroundColor: "transparent"
    textColor: "{colors.parlor-gold}"
    typography: "{typography.label}"
    rounded: "{rounded.control}"
    padding: "0.5rem 1.25rem"
    height: "2.5rem"
  button-outline-hover:
    backgroundColor: "{colors.gold-tint-10}"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.white}"
    typography: "{typography.label}"
    rounded: "{rounded.control}"
    padding: "0.5rem 1.25rem"
    height: "2.5rem"
  button-ghost-hover:
    backgroundColor: "{colors.fill-10}"
  button-secondary:
    backgroundColor: "{colors.slate}"
    textColor: "{colors.white}"
    typography: "{typography.label}"
    rounded: "{rounded.control}"
    padding: "0.5rem 1.25rem"
    height: "2.5rem"
  button-secondary-hover:
    backgroundColor: "{colors.slate-light}"
  button-destructive:
    backgroundColor: "{colors.danger-solid}"
    textColor: "{colors.white}"
    typography: "{typography.label}"
    rounded: "{rounded.control}"
    padding: "0.5rem 1.25rem"
    height: "2.5rem"
  card:
    backgroundColor: "{colors.charcoal}"
    rounded: "{rounded.card}"
    padding: "1.5rem"
  card-stat:
    backgroundColor: "{colors.charcoal}"
    rounded: "{rounded.card}"
    padding: "1.25rem"
  input:
    backgroundColor: "{colors.fill-5}"
    textColor: "{colors.white}"
    typography: "{typography.label}"
    rounded: "{rounded.control}"
    padding: "0.5rem 0.75rem"
    height: "2.5rem"
  badge-default:
    backgroundColor: "{colors.fill-10}"
    textColor: "{colors.ink-80}"
    rounded: "{rounded.pill}"
    padding: "0.125rem 0.625rem"
  badge-gold:
    backgroundColor: "{colors.gold-tint-20}"
    textColor: "{colors.parlor-gold}"
    rounded: "{rounded.pill}"
    padding: "0.125rem 0.625rem"
  badge-success:
    backgroundColor: "{colors.success-tint}"
    textColor: "{colors.success}"
    rounded: "{rounded.pill}"
    padding: "0.125rem 0.625rem"
  badge-warning:
    backgroundColor: "{colors.warning-tint}"
    textColor: "{colors.warning}"
    rounded: "{rounded.pill}"
    padding: "0.125rem 0.625rem"
  badge-error:
    backgroundColor: "{colors.danger-tint}"
    textColor: "{colors.danger}"
    rounded: "{rounded.pill}"
    padding: "0.125rem 0.625rem"
  nav-item:
    backgroundColor: "transparent"
    textColor: "{colors.ink-60}"
    typography: "{typography.label}"
    rounded: "{rounded.control}"
    padding: "0.5rem 0.75rem"
  nav-item-hover:
    backgroundColor: "{colors.fill-5}"
    textColor: "{colors.white}"
  nav-item-active:
    backgroundColor: "{colors.gold-tint-10}"
    textColor: "{colors.parlor-gold}"
  dialog:
    backgroundColor: "{colors.charcoal}"
    rounded: "{rounded.dialog}"
    padding: "1.5rem"
    width: "32rem"
---

# Design System: Pivot Parlor

<!-- Scope: this file documents the PLATFORM's own visual system, the surfaces Pivot Parlor
     shows in its own name: marketing pages, the admin/staff/developer dashboards, and the
     plain booking journey a shop gets before its site exists. Each shop's public site is a
     different world, generated per shop; the "Shop Theme Engine" entry under Components
     records the engine's invariants, not any one shop's look. -->

## Overview

**Creative North Star: "The Brass Nameplate"**

A small, well-made brass plate beside the door of a dark, quiet shop. That is the platform's whole visual attitude. Pivot Parlor's surfaces are near-black rooms lit by one warm metal: a single gold action, a gold word in the logo, a gold highlight on the active item, and otherwise white ink at measured opacities on Onyx and Charcoal. Playfair Display gives headings the hand-lettered confidence of a shopfront sign; DM Sans does the plain, quick work underneath. The platform never fills a room with gold, because the room belongs to the shop. Gold is a signature, not a paint.

The mood is discreet, warm and assured. Density is calm on marketing surfaces (generous clamp-based section padding, one idea per viewport) and compact in the back office (rows of 1.25rem by 1rem padding, stat cards, lists rather than tables). Depth is drawn with hairlines and tonal steps, not shadows, so everything sits flat and still until it needs to float. Controls respond to touch with a slight press and nothing more.

Two confirmed anti-references: the glossy black-and-gold of casinos and luxury-watch advertising (large gold areas, gradients, bevels), and the pastel marketplace look of Fresha and Treatwell (rounded pastel cards, blue call-to-actions, generic listing pages). Pivot Parlor is neither glamorous nor generic. It is a quiet, well-made fixture.

**Key Characteristics:**
- Fixed dark shell: Onyx page, Charcoal raised surfaces, white ink at 80/70/60/40 percent. There is no light mode and no user theme toggle.
- One gold per view: the primary action, plus small signatures (logo word, active nav item, avatar chip, eyebrow labels).
- Serif headings (Playfair Display 600 to 700), sans everything else (DM Sans 400 to 600), both self-hosted.
- Flat with tonal layering; shadows only on things that float (dialogs, the floating CTA, chat panels).
- 0.5rem controls, 0.75rem cards, 1rem dialogs, pills for badges and chips. Never sharp, never bubbly.
- Motion is hand-rolled CSS: colour transitions, a 95 percent press, and blur on sticky chrome. Reduced motion is honoured wherever animation exists.
- Shop sites are a separate world: every colour, radius and font on a shop page comes from that shop's generated theme tokens, never from the platform palette.

## Colors

A one-metal palette: warm gold on near-black, with white ink at opacities doing all the neutral work, and three status hues reserved for the back office.

### Primary
- **Parlor Gold** (#C9A84C): the platform's signature. Primary button fill, the "Parlor" word in the logo lockup, active nav item text, avatar chip text, eyebrow accents, the floating CTA, and focus rings. Used on at most one primary action per view.
- **Champagne** (#E2C47A): the lighter tint. Primary button hover, and the light end of the one sanctioned gradient (the marketing chatbot's launcher and header, 135 degrees from Parlor Gold to Champagne).
- **Antique Gold** (#A8872E): the deeper shade. Primary button pressed state only.
- **Gold tints** (10 / 20 / 30 percent alpha): active nav background and feature icon chips (10), gold badge fill and avatar chip fill (20), gold badge and pricing card borders (30).

### Neutral
- **Onyx** (#0D0D0D): the page. Body background, sidebar, dashboard top bar, marketing navbar (at 90 percent with blur when sticky). Also the PWA theme colour.
- **Charcoal** (#1a1a1a): the raised surface. Cards, stat cards, row lists, dialogs, the pricing card, the marketing mockup card.
- **Slate** (#2a2a2a) and **Slate Light** (#3a3a3a): secondary button fill and its hover. Nothing else.
- **White ink** at 80 / 70 / 60 / 40 percent: primary UI text sits at full white; labels and emphasised copy at 80; marketing body copy at 70; secondary and helper copy at 60; disabled or decorative glyphs at 40. Meaningful text never drops below 60.
- **Hairlines** at 10 / 20 / 40 percent white: 10 for every card, row divider (5 percent between rows), sidebar and header border; 20 for secondary button and outline badge borders; 40 for input borders, which need the extra contrast on a dark field.
- **Fills** at 5 / 10 percent white: 5 for input fields, hover on nav items and secondary text buttons; 10 for ghost button hover, default badge fill, and icon button hover.

### Status (back office only)
- **Success** (emerald, text #34d399 on a 20 percent emerald-500 tint with a 30 percent border): confirmed bookings, booked waitlist entries, up-trends.
- **Warning** (amber, text #fbbf24 on a 20 percent amber-500 tint): pending bookings, waiting queue entries, developer-view banners.
- **Danger** (red, text #f87171 on a 20 percent red-500 tint; solid #dc2626 only as the destructive button fill): cancelled, failed, down-trends, destructive outline buttons (30 percent red border, 10 percent hover fill).
- **Completed** is neutral: the default badge (10 percent white fill, 80 percent ink). A finished job needs no colour.

### Named Rules
**The Nameplate Rule.** Gold is a signature, never an area. One primary gold action per view, plus the small fixed signatures (logo word, active nav item, avatar chip, eyebrows, focus rings). Never a gold section background, never a gold panel, and the only gold gradient in the platform is the marketing chatbot's.

**The No Blue Rule.** Marketing pages, the marketing chatbot and every shop page contain no blue. In the back office, blue is retired as a status colour: pending is amber, confirmed is green, completed is neutral, cancelled is red, all through the shared Badge variants. Blue survives only as a third-party brand mark (Google, Facebook and LinkedIn sign-in buttons, the Google model badge in developer tooling) and as the one curated shop palette a shop may choose for itself ("Midnight & Ice"). Today's blue "confirmed" and "completed" states in the bookings timeline, calendar dots, analytics bars, inventory "ordered" and account "in progress" pills are drift, to be moved onto the Badge variants.

**The Two Worlds Rule.** Platform colours never appear on a shop's page. Shop components read only the shop's theme tokens (`--st-*`, `--color-accent`, `--color-brand`). The one crossover is deliberate: a shop with no generated site yet gets its booking journey rendered through the same token engine seeded with Parlor Gold on Onyx, so it looks like the platform without any component knowing it.

## Typography

**Display Font:** Playfair Display (with Georgia, serif)
**Body Font:** DM Sans (with system-ui, sans-serif)

Both are self-hosted through Fontsource in weights 400, 500, 600 and 700, registered once for the whole app; no request ever goes to Google Fonts (a consent decision, not a performance one). The same registration carries the ten curated families shop sites may use.

**Character:** a shopfront sign over a plain ledger. Playfair Display at bold weights gives every heading the assurance of hand lettering, always in white with at most one gold phrase; DM Sans keeps everything operational quick to scan and neutral in tone. The pairing is warm without being ornate.

### Hierarchy
- **Display** (700, 3rem growing to 3.75rem from 640px and 4.5rem from 1024px, line-height 1.08): the marketing hero only. One gold span inside it ("Every chair.") is the signature.
- **Headline** (700, 2.25rem, line-height 1.25): marketing section headings. Dashboard page titles use the same face one step down (1.5rem, 700).
- **Title** (600, 1.25rem): card titles (line-height 1) and dialog titles (default line-height). Marketing feature headings are 1.125rem at 600 with line-height 1.375.
- **Body** (400, 1rem, line-height 1.5): default text. Marketing lead copy steps up to 1.125rem with line-height 1.625 at 70 percent ink, capped at 65 characters. Legal and long-form pages cap the column at 48rem.
- **Label** (500, 0.875rem, line-height 1.25): buttons (600 when primary), nav items, field labels (80 percent ink), row text, secondary copy (60 percent ink), helper text at 0.75rem.
- **Eyebrow** (600, 0.75rem, uppercase, 0.05em tracking, 60 percent ink): footer column headings and section labels.

### Named Rules
**The One Serif Rule.** Playfair Display appears only in headings, card and dialog titles, stat values and the logo lockup. It never sets body copy, buttons, labels, badges, inputs or data.

**The Gold Phrase Rule.** A heading may carry one gold span and no more. Gold is never used for an entire heading.

## Layout

The page container is 80rem wide, centred, with 1rem side padding that steps to 1.5rem at 640px and 2rem at 1024px. Marketing sections breathe with fluid vertical padding (`clamp(4.5rem, 10vw, 7.5rem)` between sections; the hero uses `clamp(4.5rem, 12vw, 7rem)` below and 4rem to 5rem above). The marketing navbar is a 4rem sticky bar in Onyx at 90 percent with a 12px blur and a 10 percent hairline; under 768px it opens an inline drawer beneath the bar rather than a sheet.

Dashboards are a full-height flex shell: a fixed 15rem sidebar on the left (Onyx, 10 percent hairline on its right edge), a 3.5rem top bar, and a scrolling main area with 1.5rem padding on all sides. Content is stat-card grids and row lists, never HTML tables: a Charcoal card with a 10 percent hairline, rows divided by 5 percent hairlines, each row padded 1.25rem by 1rem, hovering to a 2 or 3 percent white fill. Below 768px the shell changes shape rather than shrinking: the page scrolls as a document under a sticky top bar (3.5rem, Onyx at 95 percent with a 12px blur, a 44px menu button, safe-area top padding when installed), the rail becomes an off-canvas drawer 18rem wide (at most 85 percent of the viewport) behind a 70 percent black scrim, and a fixed bottom tab bar (3.5rem plus the bottom safe-area inset) carries the role's primary destinations. Main content keeps 1rem side padding and clears the tab bar with 4.5rem of bottom padding plus the inset.

Spacing runs on a 4px base. The steps in use are 0.25, 0.5, 0.75, 1, 1.25, 1.5, 2 and 2.5rem. Cards pad 1.5rem (stat cards 1.25rem); controls pad 0.5rem by 1.25rem; nav items 0.5rem by 0.75rem; badges 0.125rem by 0.625rem; gaps inside controls are 0.5rem and inside nav items 0.75rem.

The app installs as a PWA. The viewport is `viewport-fit=cover`, the theme colour is Onyx, and in standalone mode the body pads itself by the device safe-area insets. Fixed chrome (bottom bars, chat launchers) must pad itself with `env(safe-area-inset-*)` because the body's padding does not reach fixed elements.

## Elevation & Depth

Flat with tonal layering. Depth is a step in surface tone and a hairline, not a shadow: Onyx for the page, Charcoal for anything raised, Slate only for the secondary button. Every raised surface carries a 10 percent white hairline; that line is the edge, and it is enough.

Shadows exist only for things that float above the page: dialogs, the marketing floating CTA, the hero mockup card, and chat panels. Sticky chrome (navbars, shop headers) uses a translucent Onyx at 90 to 95 percent with a 12px backdrop blur so content scrolls beneath it. Dialog overlays are black at 70 percent with a 4px blur. The one "glass" treatment (5 percent white fill with a 4px blur, the Card `glass` prop) is for showcase mockups on marketing pages, not for working UI.

### Shadow Vocabulary
- **Dialog** (`box-shadow: 0 25px 50px -12px rgba(0,0,0,0.25)`): modal panels only.
- **Floating CTA** (`box-shadow: 0 10px 15px -3px rgba(201,168,76,0.25), 0 4px 6px -4px rgba(201,168,76,0.25)`): the fixed marketing pill; the gold-tinted shadow is its glow.
- **Showcase card** (`box-shadow: 0 20px 25px -5px rgba(0,0,0,0.2), 0 8px 10px -6px rgba(0,0,0,0.2)`): the hero mockup and other marketing exhibits.

### Named Rules
**The Hairline Rule.** A resting surface is separated by a 10 percent white line and a tonal step, never by a shadow. If a card needs a shadow to be seen, its background is wrong.

**The Floating-Only Shadow Rule.** Shadows appear only on elements positioned above the page (fixed or modal). Cards, rows, inputs and buttons at rest cast none.

## Shapes

Soft but disciplined corners on everything. Controls (buttons, inputs, selects, nav items, icon buttons, banners) use 0.5rem. Cards, stat cards and row lists use 0.75rem. Dialogs, the pricing card, marketing feature cards and the hero mockup use 1rem. Badges, avatar chips, the "DM us" pill, the floating CTA and chat launchers are full pills. Nothing is sharp, and nothing exceeds 1rem except a pill. Borders are single 1px hairlines; there are no double borders, no bevels and no outlines other than the focus ring.

Focus is a 2px Parlor Gold ring on `:focus-visible`, offset by 2px against Charcoal on dialog close buttons. Inputs on focus swap their 40 percent hairline for a gold border plus the same 2px gold ring; error inputs use a red-500 border and ring.

Shop sites do not use these fixed radii. Each shop draws a coherent three-step radius scale from its own theme (see the Shop Theme Engine), so shop pages are rounder or tighter per shop by design.

## Components

Platform surfaces build from the shared primitives in `apps/web/app/components/ui/` (Button, Input, Card, Badge, Dialog) plus the dashboard shell (DashboardLayout, Sidebar, StatCard). The shop booking journey uses a parallel token-driven set (ThemedButton, ThemedInput, ThemedTextarea) because the shared primitives hard-code the platform brand. Icons are lucide-react at 1rem in nav and inline actions; hand-drawn SVGs exist only for social and sign-in brand marks. There is no animation library; all motion is CSS transitions and a few keyframes, with the Tailwind default 150ms ease for colour and transform changes.

### Buttons
Refined and restrained: one gold primary per view, quiet alternatives, a press you feel and nothing you watch.
- **Shape:** control radius (0.5rem), inline-flex with a 0.5rem gap, label type at 500 weight, `transition-all`, no shadow.
- **Primary:** Parlor Gold fill, Onyx text at 600 weight, 2.5rem tall, 0.5rem by 1.25rem padding. Hover Champagne, pressed Antique Gold.
- **Outline:** transparent with a 1px Parlor Gold border and gold text; hover 10 percent gold fill.
- **Ghost:** white text on nothing; hover 10 percent white fill. Used for the "secondary" marketing CTA beside a primary.
- **Secondary:** Slate fill, white text, 10 percent white hairline; hover Slate Light. The back office's "other" action.
- **Destructive:** red-600 fill, white text; hover red-700. Destructive outlines in lists use a 30 percent red-500 border, red-400 text and a 10 percent red hover fill.
- **Link:** gold text, underline on hover with a 0.25rem offset, no padding.
- **Sizes:** sm 2rem tall with 0.75rem text; default 2.5rem; lg 3rem with 1rem text and 2rem side padding; xl 3.5rem with 1.125rem text and 2.5rem side padding (marketing CTAs); icon 2.5rem square.
- **Focus:** 2px gold ring, no outline. **Disabled:** 50 percent opacity, pointer events off.
- **Press feedback:** marketing pills and shop-site tappables scale to 95 percent on `:active` (the floating CTA also lifts to 105 percent on hover). Dashboard buttons do not scale.

### Cards / Containers
- **Corner Style:** card radius (0.75rem); 1rem for dialogs and marketing exhibit cards.
- **Background:** Charcoal. The `glass` variant is 5 percent white with a 4px blur, for marketing exhibits only.
- **Shadow Strategy:** none at rest (see Elevation). Exhibit cards on marketing pages may carry the showcase shadow.
- **Border:** 10 percent white hairline, always.
- **Internal Padding:** 1.5rem, with header, content and footer each padding 1.5rem and content dropping its top padding. Stat cards pad 1.25rem and show the value in Playfair Display at 1.875rem bold with the trend line in success or danger text.
- **Row lists:** the same card holding rows divided by 5 percent hairlines, rows padded 1.25rem by 1rem, hover fill 2 to 3 percent white, with a 2rem square icon button (10 percent white hover fill) at the row's end.

### Inputs / Fields
- **Style:** 2.5rem tall, 5 percent white fill, 40 percent white 1px border, control radius, 0.5rem by 0.75rem padding, label type in white, placeholder at 60 percent ink. The field forces a dark colour scheme so native date and time pickers stay dark. Label above at 0.875rem, 500 weight, 80 percent ink, with a 0.375rem gap.
- **Focus:** gold border plus a 2px gold ring, outline removed.
- **Error:** red-500 border and ring, helper line at 0.75rem in red-400 beneath the field.
- **Disabled:** 50 percent opacity with a not-allowed cursor.
- **Selects:** the same field look. Today they are styled by hand in settings and the sidebar's view switcher rather than through a shared primitive; new selects should copy the Input classes exactly until a shared Select exists.

### Badges / Chips
- **Style:** pill, 0.125rem by 0.625rem padding, 0.75rem text at 500 weight, inline-flex with a 0.25rem gap.
- **Variants:** default (10 percent white fill, 80 percent ink), gold (20 percent gold fill, gold text, 30 percent gold border), success, warning, error (each a 20 percent tint, the 400-step text, a 30 percent border), outline (transparent with a 20 percent white border and 70 percent ink). Two brand-mark variants (anthropic in orange, google in blue) exist for the developer tooling only.
- **Status mapping:** pending is warning, confirmed is success, completed is default, cancelled or failed is error. Every status pill in the back office should come from these variants rather than a per-screen colour map.

### Navigation
- **Marketing navbar:** 4rem sticky bar, Onyx at 90 percent with a 12px blur and a 10 percent hairline beneath; links in label type at 70 percent ink brightening to white; a gold-bordered "DM us" pill (gold text, filling gold with Onyx text on hover); the 768px-and-under drawer opens inline beneath the bar with the same hairline. Footer columns are headed by eyebrows.
- **Dashboard sidebar:** 15rem, Onyx, hairline on the right, the logo lockup at the top ("Pivot" in white and "Parlor" in Parlor Gold, Playfair Display 1.125rem bold). Items are 0.5rem by 0.75rem with a 0.75rem gap to a 1rem lucide icon, label type at 60 percent ink; hover is a 5 percent white fill with white text; active is a 10 percent gold fill with gold text. The developer's view switcher is a select in the field style with a soft gold focus.
- **Dashboard top bar:** 3.5rem, Onyx, hairline beneath, page title at 0.875rem 500 in 70 percent ink, and a 2rem avatar chip (20 percent gold fill, gold initials at 0.75rem 600).
- **Dashboard phone nav:** the drawer is the same Sidebar in an 18rem panel with a 44px close button, focus-trapped, closed by navigation, Escape, the scrim, or the viewport growing past 768px. The bottom tab bar shows icon over an 11px label in 3.5rem tabs, gold when current and 60 percent ink otherwise, with `aria-current` on the active tab. Staff and developers get every destination as a tab; admins get Overview, Bookings, Queue and Point of Sale plus a More tab that opens the drawer. Marketing uses the inline drawer; shop sites use their own full-screen menu.

### Dialog
Radix dialog. Overlay black at 70 percent with a 4px blur, fading in and out. Panel centred, max 32rem wide, Charcoal, 1rem radius, 1.5rem padding, 10 percent hairline, dialog shadow, zooming from 95 percent as it fades in. Title in Playfair Display 1.25rem 600 white; description at 0.875rem 60 percent ink; the header stacks with a 0.375rem gap and a 1rem margin below. The close button sits 1rem from the top-right corner as a pill at 40 percent ink, brightening to white, with a gold focus ring offset against Charcoal.

### Pip, the marketing chatbot (signature)
The one place the platform is allowed a little theatre. A Messenger-style widget styled entirely by hand: a scissors-mark mascot, launcher and header in the 135 degree Parlor Gold to Champagne gradient, message bubbles with asymmetric 18px corners (4px at the speaker's corner), Charcoal and Slate surfaces, and its own keyframes (ping, slide-up, fade-in, bounce). On phones it becomes a full-screen sheet sliding up from the bottom; on desktop a 400px panel above the launcher. Every keyframe is disabled under `prefers-reduced-motion`. Nothing about Pip is reused elsewhere, and nothing elsewhere should imitate it.

### Shop Theme Engine (signature)
Shop pages are not styled by this palette. Each shop's look is resolved from its stored theme into CSS custom properties on the shop chrome root, and every shop component reads only those tokens through Tailwind arbitrary values (for example `text-[color:var(--st-ink)]`, `rounded-[var(--st-r-md)]`). The engine's invariants are the design system for shop sites:
- **Tokens:** `--st-bg` (page), `--st-ink` (text) and an ink alpha ramp (25 to 95 percent), hairline ramp (`--st-line-10/15/20/40`), `--color-brand` and `--color-accent` with an accent tint ramp (7 to 50 percent), `--st-accent-text`, `--st-on-accent`, surfaces (`--st-card`, `--st-card-hover`, `--st-chip`, `--st-field`, `--st-panel-1/2/3`, `--st-bubble`), `--st-header` (page colour at 95 percent for the blurred sticky header), and shadow alphas (`--st-shadow-20/25/30`).
- **Contrast floors:** the scheme (light or dark) is whichever of white or black contrasts better with the shop's background; ink is pushed to at least 4.5:1 against the background and accent text to at least 3:1; text on the accent is whichever of black or white contrasts more. Light-scheme shops get solid white cards and softer shadow alphas (0.08 to 0.12 instead of 0.2 to 0.3).
- **Per-shop shape:** a radius scale (`--st-r-lg/md/sm`) is chosen deterministically from the shop id among compact (0.75 / 0.5 / 0.375rem), classic (1 / 0.75 / 0.5rem) and soft (1.25 / 1 / 0.625rem), and the card hairline alpha from 0.08, 0.10 or 0.14. Pills stay pills.
- **Fonts:** heading and body families come from the curated, self-hosted set (Playfair Display, Cormorant Garamond, Libre Baskerville, Lora; DM Sans, Jost, Montserrat, Inter, Work Sans, Space Grotesk). Unknown names fall back by role: serif headings to Playfair Display, sans headings to Montserrat, serif body to Lora, sans body to DM Sans.
- **Palettes offered at creation:** Onyx & Gold (#0D0D0D / #C9A84C, the default), Charcoal & Amber, Espresso & Copper, Burgundy & Champagne, Midnight & Ice, Forest & Sage, Plum & Rose, Slate & Coral. Legacy sites without a palette render the pre-token look: #1a1a1a with a #d4a853 accent, which is not the platform gold.
- **Secondary text floor:** meaningful copy never below `--st-ink-50`; the 25 to 45 percent steps are decorative only. Hero copy over a photo stays literal white over black scrims (55 to 90 percent) regardless of scheme.
- **Motion:** scroll reveals (fade-up, scale, slide) at 500ms/14px in calm mode and 650ms/26px in lively mode, a 700ms hero fade, and a 45s reviews marquee that pauses on hover and becomes a swipe rail on touch. No-JS visitors see everything; `prefers-reduced-motion` removes every transition and animation.
- **Native feel chrome:** the sticky header pads itself with the top safe-area inset; a bottom booking bar slides in (250ms ease-out) once the hero scrolls away, padded by the bottom inset; the chat launcher lifts by 4.75rem while the bar shows so the two never overlap. Under 768px the shop menu is a full-screen focus-trapped modal.
- **Booking controls:** ThemedButton (primary in `--color-accent` with `--st-on-accent` text, hover and pressed derived with `color-mix` at 75 percent toward white and 85 percent toward black; ghost in ink), ThemedInput and ThemedTextarea in `--st-field`. A shop with no site yet gets these seeded with Parlor Gold on Onyx.

## Do's and Don'ts

### Do:
- **Do** build every platform surface from the shared Button, Input, Card, Badge and Dialog primitives, and every shop-page control from the Themed set.
- **Do** keep one Parlor Gold primary action per view; use ghost or secondary for everything else.
- **Do** write neutrals as white at 80 / 70 / 60 / 40 percent and hairlines at 10 / 20 / 40 percent, not as grey hex values.
- **Do** separate surfaces with a tonal step (Onyx, Charcoal) and a 10 percent hairline; save shadows for dialogs and floating chrome.
- **Do** use 0.5rem on controls, 0.75rem on cards, 1rem on dialogs and pills on chips, and read shop-page radii from `--st-r-*`.
- **Do** set headings in Playfair Display 600 to 700 in white with at most one gold span, and everything else in DM Sans.
- **Do** map back-office status to the Badge variants: pending warning, confirmed success, completed default, cancelled error.
- **Do** keep motion to colour and transform transitions of 150 to 250ms and a 95 percent press, and disable every keyframe under `prefers-reduced-motion`.
- **Do** pad fixed chrome with `env(safe-area-inset-*)` and keep sticky headers translucent Onyx with a 12px blur.
- **Do** load fonts only from the self-hosted Fontsource registration.

### Don't:
- **Don't** use blue anywhere except third-party brand marks and the Google model badge; never as a status colour.
- **Don't** fill areas with gold, use gold gradients outside Pip, or set an entire heading in gold.
- **Don't** put Playfair Display in body copy, buttons, labels, badges, inputs or data.
- **Don't** put platform colours, fonts or radii on a shop page; shop components read theme tokens only.
- **Don't** add shadows, glass or blur to resting cards, rows, inputs or buttons.
- **Don't** hand-roll a per-screen status colour map or a per-screen field style; extend the shared primitive instead.
- **Don't** use Tailwind `dark:` variants or a theme toggle; the platform shell is dark only and light appears only through a shop's own scheme.
- **Don't** add a Google Fonts link, an animation library, or HTML tables to the back office.
- **Don't** use em-dashes in interface text.
