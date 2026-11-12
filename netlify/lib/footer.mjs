/** Shared Express Help footer for server-rendered pages. Same text as public/footer.js. */
export const FOOTER_EMAIL = "jbattaglia@libertyretail.com.au";
export const FOOTER_CAR = "\u{1F3CE}\uFE0E";

export function footerHtml() {
  return '<footer class="eh-footer" data-testid="eh-footer" style="margin:24px auto 16px;padding:0 16px;max-width:960px;text-align:center;font:12px/1.5 system-ui,-apple-system,\'Segoe UI\',Roboto,sans-serif;color:#667085">'
    + 'Built, not bought, by J.Batt <span class="eh-car" role="img" aria-label="racing car" style="font-family:\'Segoe UI Symbol\',\'Noto Sans Symbols 2\',\'Noto Sans Symbols\',\'Apple Symbols\',\'DejaVu Sans\',sans-serif;font-variant-emoji:text">' + FOOTER_CAR + '</span>'
    + ' \u2014 need changes? <a href="mailto:' + FOOTER_EMAIL + '" style="color:inherit;text-decoration:underline">email me here</a></footer>';
}
