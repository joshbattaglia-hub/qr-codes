# qr-codes

Dynamic QR codes and short links: `https://expresshelp.site/r/<slug>` 302-redirects to an editable destination, with scan and click metrics (no raw IPs stored).

Stack: Netlify static + Functions (v2) + Blobs. Admin at `/admin`, password from Netlify env `ADMIN_PASSWORD`.

QR generation is client-side via vendored MIT `qrcode-generator` (`public/admin/qrcode.js`). Short links always use **`https://expresshelp.site/r/<slug>`**. Downloaded QR images use the same path with `?qr=1` so scans can be counted apart from link clicks. Optional env `PUBLIC_URL` documents the public base.

## Admin

After the password gate:

| Area | What it does |
| --- | --- |
| Home | Quick create for a QR code or a short link, 1d / 7d / 30d engagements, link clicks, QR scans, and page clicks |
| Links | Short links as their own records, with click analytics |
| QR Codes | Destination, tags, created date, colour and logo customization, PNG/SVG download, dynamic routing, and scan analytics |
| Analytics | Workspace totals from stored scans and clicks, with CSV download |
| Pages, Campaigns, Custom domains, Integrations | Placeholders. Custom domains lists the live `expresshelp.site` hostname; extra names are still configured in DNS and Netlify |
| Settings | Workspace name, default QR colours, public URL, log out |

QR detail analytics include a date range, previous-period or code comparison, unique visitors versus total scans, scans over time, and breakdowns by country, city, browser, and operating system. There are no upgrade gates. Dynamic routing rules send a device or a location to a different http(s) destination; everyone else gets the main URL.

Visitor uniqueness is a daily hash of IP and user agent. The raw IP is not written to Blobs. Pause, delete, and destination edits behave as before.

Local UI smoke test (memory store, not production data): `ADMIN_PASSWORD=liberty-dev npm run dev`, then open `http://127.0.0.1:8888/admin`.

## Live

| Role | URL |
| --- | --- |
| Primary | https://expresshelp.site |
| Alias | https://www.expresshelp.site → apex |
| Admin | https://expresshelp.site/admin |
| Short link | https://expresshelp.site/r/&lt;slug&gt; |
| Fallback Netlify URL | https://liberty-qr-353.netlify.app |

## VentraIP DNS (external DNS — do not change nameservers)

From [Netlify external DNS docs](https://docs.netlify.com/manage/domains/configure-domains/configure-external-dns/):

| Type | Host / Name | Value | Notes |
| --- | --- | --- | --- |
| **A** | `@` (apex) | `75.2.60.5` | Netlify load balancer (fallback when ALIAS/ANAME unavailable) |
| ALIAS/ANAME (optional preferred) | `@` | `apex-loadbalancer.netlify.com` | Use instead of A if VentraIP supports it |
| **CNAME** | `www` | `liberty-qr-353.netlify.app` | No trailing dot unless VentraIP requires one |

Do **not** add AAAA for the apex when using the A-record path. Remove parking A/CNAME records that conflict.

SSL: Netlify provisions HTTPS after DNS verifies. Until then the custom domain may show as pending / not force-SSL.

## Deploy

```bash
npx netlify deploy --prod --build
```

Env (Netlify site `liberty-qr-353`):

- `ADMIN_PASSWORD` — admin login
- `PUBLIC_URL=https://expresshelp.site` — documents public short-link base
