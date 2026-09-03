const TAG_SHAPE = /^[A-Za-z]{2,3}(?:[-_][A-Za-z0-9]{2,8})*$/;

type DisplayNamesCtor = typeof Intl.DisplayNames | undefined;
const DisplayNames = (Intl as unknown as { DisplayNames?: DisplayNamesCtor }).DisplayNames;

/** `en_us` → `en-US`, `zh-hans-cn` → `zh-Hans-CN`, `tr.json` → `tr`. */
export function normalizeLocaleTag(input: string): string {
  if (!input) return '';
  const trimmed = input.trim();
  const withoutExt = trimmed.toLowerCase().endsWith('.json') ? trimmed.slice(0, -5) : trimmed;
  if (!withoutExt) return '';
  const segments = withoutExt.split(/[-_]/).filter(Boolean);
  if (!segments.length) return '';
  return segments
    .map((segment, index) => {
      if (index === 0) return segment.toLowerCase();
      if (segment.length === 2) return segment.toUpperCase();
      if (segment.length === 4) return segment.charAt(0).toUpperCase() + segment.slice(1).toLowerCase();
      return segment;
    })
    .join('-');
}

/** True when Intl knows `code` as a language (so `app` and `common` are rejected). */
export function isKnownLanguage(code: string): boolean {
  if (!/^[A-Za-z]{2,3}$/.test(code)) return false;
  if (!DisplayNames) return true; // no Intl data: trust the shape
  try {
    const name = new DisplayNames(['en'], { type: 'language', fallback: 'code' }).of(code.toLowerCase());
    return typeof name === 'string' && name.toLowerCase() !== code.toLowerCase();
  } catch {
    return false;
  }
}

/** True for `en`, `en-US`, `pt_BR`, `zh-Hans-CN`; false for `common`, `app`, `messages.en`. */
export function looksLikeLocaleTag(name: string): boolean {
  if (!name || !TAG_SHAPE.test(name)) return false;
  return isKnownLanguage(name.split(/[-_]/)[0]);
}

/**
 * Locale carried by a file name: the whole name (`en`, `pt_BR`) or a trailing
 * dot segment (`messages.en-US`). Undefined for namespace-like names.
 */
export function detectLocaleFromFileName(fileName: string): string | undefined {
  if (looksLikeLocaleTag(fileName)) return normalizeLocaleTag(fileName);
  const segments = fileName.split('.').filter(Boolean);
  for (let i = segments.length - 1; i > 0; i--) {
    if (looksLikeLocaleTag(segments[i])) return normalizeLocaleTag(segments[i]);
  }
  return undefined;
}

export function describeLocale(tag: string): string | undefined {
  if (!DisplayNames) return undefined;
  try {
    const segments = tag.split('-');
    const language = segments[0];
    const region = segments.find(seg => seg.length === 2 && seg === seg.toUpperCase());
    const script = segments.find(seg => seg.length === 4);
    const languageName = new DisplayNames(['en'], { type: 'language' }).of(language) || language;
    const scriptName = script ? new DisplayNames(['en'], { type: 'script' }).of(script) : undefined;
    const regionName = region ? new DisplayNames(['en'], { type: 'region' }).of(region) : undefined;
    if (regionName && scriptName) return `${languageName} (${scriptName} - ${regionName})`;
    if (regionName) return `${languageName} (${regionName})`;
    if (scriptName) return `${languageName} (${scriptName})`;
    return languageName;
  } catch {
    return undefined;
  }
}
