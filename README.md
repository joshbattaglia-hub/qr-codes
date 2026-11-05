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
| Analytics | Workspace totals from stored scans, clicks, and page views, with CSV download |
| Pages | Landing pages at `/p/<slug>`: content, form fields, publish, submissions CSV, and page views. A page can also create a QR code or short link to itself |
| Competitions | Site draws at `/c/<slug>`: weekly or single schedule, one entry per person per period, receipt-hash dedupe, random draw, archive, winners, and CSV import |
| Sites | Groups QR codes, pages, and competitions by location. Head office sees every site plus unassigned legacy records |
| Custom domains | Placeholder. Lists the live `expresshelp.site` hostname; extra names are still configured in DNS and Netlify |
| Settings | Workspace name, default QR colours, public URL, and head-office staff setup |

Published pages are mobile-first and use Liberty colours unless the page sets its own. Draft pages return an unavailable page. Each visit to a published page counts as a page click on Home. Form submissions are stored in Blobs. Set `RESEND_API_KEY`, `RESEND_FROM`, and `RESEND_TO` to email a copy of each page submission, competition entry, or draw; without those, everything is still saved and nothing is sent.

Competitions use Australia/Melbourne for entry times and weekly draw windows. Activating one creates a QR code and a short link to `https://expresshelp.site/c/<slug>`. A draw picks from that period’s valid entries, archives them, and opens the next period. The same email or phone can enter again next period; the same receipt cannot. CSV import accepts the Liberty Site Competitions columns (Entry ID, Name, Contact, Contact Type, Status, Duplicate Reason, Timestamp). Competition page views are included in Home page clicks.

QR detail analytics include a date range, previous-period or code comparison, unique visitors versus total scans, scans over time, and breakdowns by country, city, browser, and operating system. There are no upgrade gates. Dynamic routing rules send a device or a location to a different http(s) destination; everyone else gets the main URL.

Visitor uniqueness is a daily hash of IP and user agent. The raw IP is not written to Blobs. Pause, delete, and destination edits behave as before.

## Sites, templates, posters, and the rest

Nothing here creates sites, staff, or offers on its own. Existing records stay unassigned and keep their links.

- **Sites.** Head office adds location names under Sites and assigns QR codes, pages, and competitions. Unassigned records stay visible only to head office.
- **Staff.** Head office can create a manager from Settings. The password is hashed with scrypt and is not returned by the API. A manager session is a separate `qr_staff` cookie and is checked against the current staff record on every request, so disabling the person or removing a site applies immediately. Managers only see their assigned sites. Leave the staff email blank on the login form to use `ADMIN_PASSWORD` as head office, the same way as before. No manager is created until someone does it.
- **Templates and copies.** Saving a template, copying a competition, or using a template creates a new draft slug. Entries, winners, collection notes, and voucher tokens are not copied. The offer on a copy is off. The original record is not changed.
- **Posters.** A competition poster is A4 or A3 HTML. Its QR code encodes `https://expresshelp.site/c/<slug>`. A QR-code poster encodes the existing `https://expresshelp.site/r/<slug>?qr=1` address. Use the browser print dialog. No extra service is required.
- **Reminders.** Home lists upcoming and overdue draws and closing dates in Australia/Melbourne. They are calculated when the admin loads. Nothing is emailed.
- **Winner collection.** Each winner can be marked pending, collected, or unclaimed, with a note and an audit line. Review notice builds text from the name and contact already stored on that winner. Liberty does not send it.
- **Vouchers.** Off unless a competition or QR code has `voucher.enabled` set. There is no default offer text. A voucher token is 32 random bytes. Issuing the same entry or the same QR visitor twice returns the one existing token. Redeeming uses Netlify Blobs `setJSON(..., { onlyIfMatch: etag })` (`If-Match`). The write counts only when the result is `{ modified: true }`. If the store does not return an etag, redemption is refused and nothing is written. Admin lists show an audit row without the token.
- **Link checks.** Check destination runs from the QR or link screen. `403`, `429`, timeouts, and DNS failures are unknown, not broken. The checker refuses non-http(s) URLs, URLs with a username or password, and hosts that resolve to loopback, private, link-local, or local names. That check runs before the request and again inside the connection lookup, including after a redirect. It does not send cookies or an authorization header, and it does not record a scan or a page view.

`@netlify/blobs` v11 supports those conditional writes in production and in `netlify dev`. This app's memory backend used for tests and `npm run dev` implements the same `onlyIfNew` and `onlyIfMatch` results. No new account or paid add-on is required.

Local UI smoke test (memory store, not production data): `ADMIN_PASSWORD=liberty-dev npm run dev`, then open `http://127.0.0.1:8888/admin`.

## Live

| Role | URL |
| --- | --- |
| Primary | https://expresshelp.site |
| Alias | https://www.expresshelp.site → apex |
| Admin | https://expresshelp.site/admin |
| Short link | https://expresshelp.site/r/&lt;slug&gt; |
| Landing page | https://expresshelp.site/p/&lt;slug&gt; |
| Competition | https://expresshelp.site/c/&lt;slug&gt; |
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
- `PUBLIC_URL=https://expresshelp.site` — documents public short-link and page base
- `RESEND_API_KEY`, `RESEND_FROM`, `RESEND_TO` — optional email when a landing page receives a submission
