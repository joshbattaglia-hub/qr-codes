/** Express Help logo for HTML email. Email clients can't be trusted with inline SVG, so this is a hosted PNG (shown at 197 x 48, file is 2x). Plain-text emails don't use it. */
export const LOGO_EMAIL_URL = "https://expresshelp.site/brand/logo-lockup-email.png";
export const LOGO_EMAIL_W = 197;
export const LOGO_EMAIL_H = 48;

export function emailLogoHtml() {
  return '<div data-testid="email-logo" style="margin:0 0 18px"><a href="https://expresshelp.site/admin/" style="text-decoration:none;border:0">'
    + '<img src="' + LOGO_EMAIL_URL + '" alt="Express Help" width="' + LOGO_EMAIL_W + '" height="' + LOGO_EMAIL_H + '" style="display:block;border:0;outline:none;width:' + LOGO_EMAIL_W + 'px;height:' + LOGO_EMAIL_H + 'px"></a></div>';
}
