# qr-codes

Dynamic QR codes: `https://expresshelp.site/r/<slug>` 302-redirects to an editable destination, with scan metrics (no raw IPs stored).

Stack: Netlify static + Functions (v2) + Blobs. Admin at `/admin`, password from Netlify env `ADMIN_PASSWORD`.

QR generation is client-side via vendored MIT `qrcode-generator` (`public/admin/qrcode.js`). Short links / QR payloads always use **`https://expresshelp.site/r/<slug>`** (not the `*.netlify.app` host). Optional env `PUBLIC_URL` documents the same base.

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
