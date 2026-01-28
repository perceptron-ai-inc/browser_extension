const INTERNAL_URL_PREFIXES = ["chrome://", "chrome-extension://", "about:", "devtools://"];

export function isInternalUrl(url: string): boolean {
  return !url || INTERNAL_URL_PREFIXES.some((prefix) => url.startsWith(prefix));
}
