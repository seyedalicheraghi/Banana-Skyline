// Reading the Earth Rovers SDK's .env the way the SDK (python-dotenv) does, without printing it: it holds a secret.

/** A value as python-dotenv reads it: the last assignment wins; a quoted value is taken as is ('#' included), an
 *  unquoted one ends at " #". '' when the name is not assigned. */
export function dotenvValue(text, name) {
  const lines = [...text.matchAll(new RegExp(`^[ \\t]*(?:export[ \\t]+)?${name}[ \\t]*=(.*)$`, 'gm'))];
  const raw = (lines.at(-1)?.[1] ?? '').replace(/\r$/, '').trim();
  const quoted = /^(["'])(.*?)\1/.exec(raw);
  return quoted ? quoted[2] : raw.replace(/\s+#.*$/, '');
}

/**
 * The slug FrodoBots knows a rover by (lowercase, words joined by dashes, like weld-arm-ultron) for a name
 * written with spaces or capitals; null when the name needs no change. Its display name gets
 * 404 "Bot unavailable for SDK".
 */
export function slugForm(name) {
  const trimmed = name.trim();
  if (!/[\sA-Z]/.test(trimmed)) return null;
  return trimmed.toLowerCase().replace(/\s+/g, '-').replace(/^-+|-+$/g, '');
}
