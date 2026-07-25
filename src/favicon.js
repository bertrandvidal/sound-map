// Local and deployed tabs must be tellable apart at a glance. Both icons draw
// the same globe; the dev one shifts hue and inverts its linework so the
// difference survives a 16px favicon and colour-vision deficiency.
export const FAVICON_PROD = "/favicon.svg";
export const FAVICON_DEV = "/favicon-dev.svg";

export function faviconHref(isDev) {
  return isDev ? FAVICON_DEV : FAVICON_PROD;
}

// index.html already ships the production icon, so the tab is never blank
// before this runs. Reuse that link when present rather than appending a
// second one, which would leave the browser to pick between them.
export function applyFavicon(doc, isDev) {
  let link = doc.querySelector("link[rel='icon']");
  if (!link) {
    link = doc.createElement("link");
    link.setAttribute("rel", "icon");
    doc.head.appendChild(link);
  }
  link.setAttribute("type", "image/svg+xml");
  link.setAttribute("href", faviconHref(isDev));
  return link;
}
