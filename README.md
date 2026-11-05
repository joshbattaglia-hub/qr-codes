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
- **Staff.** Head office can create a manager from Settings. Managers do not see that form or the control for adding a site. The password is hashed with scrypt and is not returned by the API. A manager session is a separate `qr_staff` cookie, signed with a different label from the head-office cookie, and is checked against the current staff record on every request, so disabling the person or removing a site applies immediately. Managers only see their assigned sites. Leave the staff email blank on the login form to use `ADMIN_PASSWORD` as head office. Login attempts are counted in Blobs: 8 per account and 80 per client address hash in each 10 minute window. If that counter cannot be written, the login is refused. A browser request whose `Origin` is a different host, or whose `Sec-Fetch-Site` is `cross-site`, is rejected. No manager is created until someone does it.
- **Templates and copies.** Saving a template, copying a competition, or using a template creates a new draft slug. Entries, winners, collection notes, and voucher tokens are not copied. The offer on a copy is off. The original record is not changed.
- **Posters.** A competition poster is A4 or A3 HTML. Its QR code encodes `https://expresshelp.site/c/<slug>`. A QR-code poster encodes the existing `https://expresshelp.site/r/<slug>?qr=1` address. Use the browser print dialog. No extra service is required.
- **Reminders.** Home lists upcoming and overdue draws and closing dates in Australia/Melbourne. A draw that is already overdue stays on the list after the competition is ended or its closing date has passed. A finished draw schedule does not. Nothing is emailed.
- **Winner collection.** Each winner can be marked pending, collected, or unclaimed, with a note and an audit line. Review notice builds text from the name and contact already stored on that winner. Liberty does not send it.
- **Vouchers.** Off unless someone enables that competition or QR code. Enabling requires offer text, terms, an expiry that is today or later in Melbourne, and a maximum number of vouchers from 1 to 500. Saving the editor with the box unchecked does not turn an offer on. A token is 32 random bytes and is omitted from admin lists. The same person's entry retry returns the same token. A different person who reuses the idempotency key gets a conflict and not the token. The same receipt does not issue a second voucher. A QR visitor gets one token; further scans from that visitor return it, and one client address can take at most 3 distinct QR vouchers for a code. Redeeming uses Netlify Blobs `setJSON(..., { onlyIfMatch: etag })`. The redeem counts only when the result is `{ modified: true }`. A lost race or a repeat redeem returns HTTP 409. If the store returns no etag, or the conditional write cannot be confirmed, nothing is redeemed.
- **Link checks.** Check destination runs from the QR or link screen. `403`, `429`, timeouts, and DNS failures are unknown, not broken. The checker refuses non-http(s) URLs, URLs with a username or password, and hosts that resolve to loopback, private, link-local, or local names. That check runs before the request and again inside the connection lookup, including after a redirect. It does not send cookies or an authorization header, and it does not record a scan or a page view.

`@netlify/blobs` is pinned at 11.1.7. Stores are opened with `consistency: "strong"`. Conditional writes are the documented `onlyIfMatch` / `onlyIfNew` options, and a write is accepted only when `modified` is true. Verified against the installed SDK (`node_modules/@netlify/blobs/dist/main.d.ts` `WriteResult` and `onlyIfMatch`, `dist/main.js` `setJSON` returning `{ modified: false }` on HTTP 412 or 409, and `dist/chunk-SQCJ2S3G.js` using the store consistency unless a call overrides it) and the Netlify Blobs docs: https://docs.netlify.com/build/data-and-storage/netlify-blobs/ (conditional `set` / `setJSON`, and the strong-consistency section). On the Netlify edge runtime, strong consistency needs `uncachedEdgeURL`; the SDK throws if it is missing, so a redeem does not fall through to a plain write. The memory backend used by tests and `npm run dev` implements the same compare-and-set. No new account or paid add-on is required.

A health check does not call the redirect counter. Destinations on this site's `/r/`, `/p/`, or `/c/` paths are reported as unknown and are not requested, so a check cannot add a visit. Private and IPv4-mapped addresses are refused again inside the connection lookup.

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
