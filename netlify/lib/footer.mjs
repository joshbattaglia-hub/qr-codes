/** The one Express Help footer for server-rendered pages and emails. Same text as public/footer.js. */
export const FOOTER_EMAIL = "jbattaglia@libertyretail.com.au";
export const FOOTER_LEAD = "Cowabunga - please hesitate to reach out";
export const FOOTER_LINK_TEXT = "email me here";
export const FOOTER_STYLE = "margin:24px auto 16px;padding:0 16px;max-width:960px;text-align:center;font:11px/1.5 system-ui,-apple-system,'Segoe UI',Roboto,Arial,sans-serif;color:#667085";

export function footerHtml() {
  return '<footer class="eh-footer" data-testid="eh-footer" style="' + FOOTER_STYLE + '">'
    + FOOTER_LEAD + ' <a href="mailto:' + FOOTER_EMAIL + '" style="color:inherit;text-decoration:underline">' + FOOTER_LINK_TEXT + '</a></footer>';
}

/** Plain-text emails. */
export function footerText() {
  return FOOTER_LEAD + " " + FOOTER_LINK_TEXT + ": mailto:" + FOOTER_EMAIL;
}
