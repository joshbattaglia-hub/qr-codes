/** Deploy previews, branch deploys and CLI draft/alias deploys all share the live site's data.
 *  Git-backed previews set context.deploy.context to deploy-preview or branch-deploy.
 *  CLI draft deploys often still report context "production"; their URLs use the
 *  `{alias-or-id}--{site}.netlify.app` form, which the live site does not. */
export function isPreviewDeploy(req, context) {
  const ctx = context?.deploy?.context;
  if (ctx && ctx !== "production") return true;
  try {
    return /--[a-z0-9-]+\.netlify\.app$/.test(new URL(req.url).hostname.toLowerCase());
  } catch {
    return false;
  }
}

export function previewReadOnly(req, context) {
  return isPreviewDeploy(req, context) && !["GET", "HEAD", "OPTIONS"].includes(req.method || "GET");
}
