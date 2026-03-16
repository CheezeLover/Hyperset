/**
 * The opened-page tracker has been moved to the browser.
 *
 * The current Superset URL is now tracked in React state in HypersetLayout
 * and passed directly to each chat request in the POST body.  There is no
 * longer any server-side store — this file is kept as a stub so existing
 * imports compile without modification.
 */

// No-op exports kept for backwards compatibility with any direct imports.
export function setOpenedPageForUser(
  _keys: Array<string | undefined>,
  _rawUrl: string,
  _reason?: string,
): null {
  return null;
}

export function getOpenedPageForKey(_key: string): null {
  return null;
}
