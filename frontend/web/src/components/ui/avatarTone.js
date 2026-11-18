const TONES = ['clay', 'honey', 'sage', 'lagoon', 'cocoa'];

/** A stable tone for someone who has not been given one, so they keep the same colour everywhere. */
export function toneFor(name) {
  let hash = 0;
  for (const character of String(name ?? '')) {
    hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  }
  return TONES[hash % TONES.length];
}
