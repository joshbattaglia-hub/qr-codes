# Express Help brand

Hand-built SVG (no raster, no base64). The wordmark is **outlined paths** from Inter Bold (SIL Open Font License), so it renders the same everywhere. `src/build-logo.py` regenerates every file here.

| File | Use |
| --- | --- |
| `logo-mark.svg` | Icon only. Navy tile, white spanner and screwdriver, red bolt. For light backgrounds. |
| `logo-mark-dark.svg` | Same icon with a white outline ring so the navy tile holds its edge on dark backgrounds. |
| `logo-lockup.svg` | Mark + "Express Help" wordmark in navy. Light backgrounds (Light and Crazy sidebars, sign-in, emails). |
| `logo-lockup-dark.svg` | Mark with white ring + white wordmark. Dark backgrounds (Dark theme sidebar). |
| `logo-mark-mono.svg`, `logo-mark-mono-white.svg` | One colour (navy / white): outline, tools and bolt in a single ink. For fax, stamps, single-colour print. |
| `logo-lockup-email.png` | Lockup, 394 x 96 px (shown at 197 x 48) for HTML email, where inline SVG is not safe. |
| `/favicon.svg`, `/favicon-32.png`, `/favicon-16.png`, `/favicon.ico`, `/apple-touch-icon.png` | Favicon set (site root). The apple icon is a full-bleed navy square (iOS rounds it). |

## Colours
- Navy `#0B2559` (tile, wordmark on light)
- Red `#E11D2E` (bolt)
- White `#FFFFFF` (tools, wordmark on dark, ring)

## Clear space and size
- Keep clear space of half the tile height (`0.5 x`) on every side of the mark or lockup.
- Minimum size: mark 16 px (favicon), lockup 24 px tall. Below 24 px use the mark alone.
- Do not recolour the bolt, stretch the logo, or put the navy variants on a navy or near-black background (use the dark variants).
- Print sheets (warehouse stickers, asset labels) carry no logo.
