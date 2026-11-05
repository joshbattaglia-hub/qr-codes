# qr-codes
Dynamic QR codes: `/r/<slug>` 302-redirects to an editable destination, with scan metrics (no raw IPs stored).
Stack: Netlify static + Functions (v2) + Blobs. Admin at `/admin`, password from Netlify env `ADMIN_PASSWORD`.
QR generation is client-side via vendored MIT `qrcode-generator` (public/admin/qrcode.js).
Deploy: `npx netlify deploy --prod --build`.
