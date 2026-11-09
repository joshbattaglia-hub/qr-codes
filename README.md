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
- **Asset Barcodes.** A separate admin tab at `#/assets` draws standard Code 39 stickers in the browser. It does not read sites, offers, or customer data, and it is not the POS Code 128 voucher. The default ID is `LOC50924` and the default heading is `Liberty Oil Convenience`. Bars stay black on white. Scanners may report the prefix `]A0`; that prefix is not encoded. There is no checksum and no full-ASCII mode. Lower-case is rejected unless the operator confirms uppercase conversion.
- **POS setup.** Head office and site managers can save a draft for Quickfuel: offer, conditions, Melbourne dates, eligible sites, a point-of-sale redemption request of single-use or reusable, and a shareable claim-link distribution. The download is a zip with Code 128 artwork, JSON, a provisional CSV, setup notes, and review-only request text. Until Neil or Joshua approves the current revision, the package is marked draft / unapproved. Quickfuel’s barcode and import format are not known, so the package stays provisional. It is not a Quickfuel file, a GTIN, or an activated offer. A single-use choice is a request for the point-of-sale system. It does not make the barcode single-use, and it does not change web voucher redemption. Managers only see drafts whose sites are all assigned to them. Unassigned drafts stay with head office.
- **Approval.** Neil or Joshua may approve. One verified approver is enough. Send for approval emails both Neil and Joshua. Each message has its own review link. One verified approval is enough. The requester clicks Send for approval. Opening the link does not approve. Approval is a separate sign-in and submit. After a real approval, the product sends the requester a confirmation when mail is configured. The requester then returns to POS setup and explicitly sends the approved package to `support@quickfuel.com.au`. Approval does not forward that package. Even after that send, Quickfuel support is still unconfirmed, and the claim link is not published. Set `RESEND_API_KEY` and `RESEND_FROM` before any of those emails can be accepted by the provider. Without them the buttons stay disabled and nothing is marked sent. A lost provider response is not retried and is not shown as sent.
- **Work accounts.** Microsoft Entra ID is the work-account sign-in. It stays off until the tenant id, client id, client secret, session secret, and object-id role map are set. Rights come only from those object ids. An email address does not grant access, and the shared head-office password cannot appoint approvers. The Web redirect URI is `https://expresshelp.site/api/identity/entra/callback`. The logout return, if Microsoft logout is used, is `https://expresshelp.site/admin`. Scopes are `openid profile` only. Test switches `ALLOW_FIXTURE_IDENTITY_BIND` and `ENTRA_ALLOW_TEST_ISSUER` must stay unset in production. The server checks the Entra signature, tenant, and object id, and ignores any email typed in a request. `IDENTITY_BIND_TOKEN` cannot assign Neil or Joshua.
- **Visitor log.** Separate public pages at `/visit/sign-in` and `/visit/sign-out`. `/visit` still links to both. Sign-out asks for the visitor name, company, and the Shell card confirmation. It signs out only when that pair matches one visit that is still on site. A receipt is still accepted by the sign-out API for an older client or an admin recovery, and it is not shown on the public form. Name and company are not proof of identity. The visitor types the site or suburb. It is not chosen from the imported site directory and it does not use a site id. Sign-in asks for name, phone, company, an optional note, and a required JPEG or PNG photo of an ID. HEIC is rejected. The photo is re-encoded so camera metadata is not kept. Sign-out uses the one-time receipt from sign-in and an explicit confirmation that the Shell card went back to the lockbox. The form does not sign anyone out by itself. ID photos are deleted 90 days after sign-out. If nobody signs out, the ID photo is deleted 90 days after sign-in and the visit stays open for review. A late sign-out does not restore that photo. The written record stays until Joshua deletes it. Public submission stays closed until Joshua's visitor-log access map, the private spreadsheet credential, and `VISITOR_COLLECTION=open` are all set. The spreadsheet credential alone does not open the form. Leave `VISITOR_COLLECTION` unset until a later explicit decision to open collection. Only an explicit visitor-log grant for Joshua (`jbattaglia@libertyretail.com.au`, or a future Entra object id written in `VISITOR_ACCESS_MAP`) can list, export, recover a receipt, change notification settings, or open an ID photo. Neil, the shared password, and POS roles do not. Notifications are off until Joshua turns them on. Mail then contains the typed location, the time, and an admin link, not the visitor's name, phone, or photo. A private Google Sheet can mirror the written record. The photo cell is only `https://expresshelp.site/admin#/visitors/<id>`, which opens that record after Joshua signs in. It is not a public photo URL or a bearer token. Deleting a record clears that sheet row. Google Sheets version history and Google backups can still hold older cell values; this app cannot erase those. No sheet is shared yet. The server credential, when set later, should use the spreadsheets scope only.
- **Email codes.** A separate sign-in for people on an explicit allowlist. It does not use Microsoft and it does not need a tenant. It stays off until `OTP_SESSION_SECRET` (at least 32 characters), `OTP_ALLOWLIST`, `RESEND_API_KEY`, and `RESEND_FROM` are all set on this site. `POS_MAIL_MOCK` does not turn it on. The code is 8 digits from a CSPRNG, kept for 10 minutes, stored only as an HMAC, and accepted once by a compare-and-set. A failed or unknown send deletes that code and is not retried. The page gives the same response for an unknown address and a failed send. Codes are not put in links, logs, or error text. Limits are counted in Blobs for the address and for Netlify's `x-nf-client-connection-ip`. `X-Forwarded-For` is not trusted. Rights are read from the allowlist on every request. Removing an entry or setting `disabled: true` ends access. `allSites` is rejected. An empty `siteIds` list grants no sites. Neil and Joshua can be approvers only at `nanderson@libertyretail.com.au` and `jbattaglia@libertyretail.com.au`. No Jeremy or regional-manager address is known, so none is created here. The same address in Entra does not add OTP sites, and OTP does not add Entra sites. Mailbox access is weaker than corporate MFA: anyone who can read the mailbox can enter the code. Entra remains the stronger sign-in when it is configured.
- **Claim links.** A draft can reserve a shareable claim link. The public claim route stays closed until the revision is approved, Quickfuel confirmation is recorded, and activation is recorded. This release has no control that records that confirmation or activation. Admin claim preview is signed-in only.
- **Site import.** Head office can preview and apply a JSON location file. `loc` is stored separately from the internal site id. Address, operational region, and geographic state are separate, and state is never copied from the region. Duplicate LOC, name, or address rows are held, as are explicit `hold: true` rows. Existing sites are matched only when one site is unambiguous, and non-empty fields are not overwritten. A second run of the same file makes no changes. The dry-run command does not need credentials. A live read or apply uses `NETLIFY_SITE_ID` and `NETLIFY_AUTH_TOKEN` from the environment and does not read auth files:

  `node scripts/import-sites.mjs --file rows.json`

  `NETLIFY_SITE_ID=... NETLIFY_AUTH_TOKEN=... node scripts/import-sites.mjs --file rows.json --apply`
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

- `ADMIN_PASSWORD` — head-office login. It is not an identity and it does not sign email codes.
- `PUBLIC_URL=https://expresshelp.site` — documents public short-link and page base
- `RESEND_API_KEY`, `RESEND_FROM` — required before approval mail or email codes can be sent. Use a new sending-only key and a verified From address on this site. Do not copy another site's key. `RESEND_TO` is the older landing-page recipient and is not the OTP allowlist.
- `OTP_SESSION_SECRET` — at least 32 random characters. Signs email-code sessions and the code digest. Leave it unset until that sign-in is intentionally enabled.
- `OTP_ALLOWLIST` — JSON object keyed by the exact mailbox. Example shape, not a grant to deploy:

```json
{
  "nanderson@libertyretail.com.au": { "approverKey": "neil", "siteIds": ["s0123abcd"] },
  "jbattaglia@libertyretail.com.au": { "approverKey": "joshua", "preparerClass": "joshua", "siteIds": ["s0123abcd"] }
}
```

  `approverKey` is only `neil` or `joshua`, and only on those two addresses. `preparerClass` is `regional-business-manager`, `jeremy`, or `joshua`. `joshua` is allowed only on Joshua's address. A preparer mailbox has to be written by someone who already knows that person and their site ids. `siteIds` are internal `s` plus 8 hex characters. Each entry may list up to 200 explicit ids, which covers the current 90 imported sites. A longer list is rejected whole and is not trimmed. `allSites` and `unassigned` are rejected with the entry. `disabled: true` removes that mailbox. No entry is seeded.
- `VISITOR_ACCESS_MAP` — visitor-log grant only. `{"joshuaOtp": true}` allows Joshua's OTP identity to open every visitor-log record. A later `joshuaEntraOid` must be that exact object id. `siteIds` or `allSites` makes this map invalid. It does not change POS site scope. Public submission stays closed until this map grants Joshua, the three `VISITOR_SHEETS_*` values are set, and `VISITOR_COLLECTION` is exactly `open`. Leave that unset for the connection check. Photo retention is fixed in code: 90 days after sign-out, or 90 days after sign-in when the visit never signs out. `VISITOR_COLLECT` and `VISITOR_OPEN_VISIT_PHOTO_DAYS` do not open the form or change that clock.
- `VISITOR_SHEETS_SPREADSHEET_ID`, `VISITOR_SHEETS_CLIENT_EMAIL`, `VISITOR_SHEETS_PRIVATE_KEY` — later, for the visitor-log sheet only. The spreadsheet id is the id, not the full URL. The private key may be a multiline PEM or the JSON `private_key` value with `\n` sequences. After this build is deployed, Joshua runs the one synthetic connection check from Visitor log in the admin while signed in with his email code. `netlify functions:invoke` only runs a local function and must not be used to copy the production key. Leave `VISITOR_COLLECTION` unset. The server exchanges a service-account JWT at `https://oauth2.googleapis.com/token` with grant `urn:ietf:params:oauth:grant-type:jwt-bearer` and scope `https://www.googleapis.com/auth/spreadsheets` only. Values are written with `valueInputOption=RAW` on a tab named `Visits`. Create that tab first. The app writes the header row when A1 is not already `visit_id`. It does not create the spreadsheet or the tab. Share that private sheet with Joshua and the service account. Do not share it publicly or with Neil. Nothing here is configured, so no sheet is shared. Headers: `visit_id`, `location`, `visitor_name`, `phone`, `company`, `issues`, `signed_in_at_utc`, `signed_in_melbourne`, `signed_out_at_utc`, `signed_out_melbourne`, `card_returned`, `record_url`, `photo_status`, `review`, `updated_at`. A manual delete clears the written cells and sets `photo_status` to `deleted`. That does not erase Google Sheets version history or Google backups.
