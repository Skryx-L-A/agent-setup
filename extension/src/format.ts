// German, emoji-free display helpers.

export function relativeTime(iso: string | undefined, now: Date = new Date()): string {
  if (!iso) {
    return 'unbekannt';
  }
  const then = Date.parse(iso);
  if (Number.isNaN(then)) {
    return 'unbekannt';
  }
  const seconds = Math.round((now.getTime() - then) / 1000);
  if (seconds < 0) {
    return 'gerade eben';
  }
  if (seconds < 60) {
    return 'gerade eben';
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return minutes === 1 ? 'vor 1 Min.' : `vor ${minutes} Min.`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return hours === 1 ? 'vor 1 Std.' : `vor ${hours} Std.`;
  }
  const days = Math.floor(hours / 24);
  if (days < 7) {
    return days === 1 ? 'gestern' : `vor ${days} Tagen`;
  }
  const weeks = Math.floor(days / 7);
  if (weeks < 5) {
    return weeks === 1 ? 'vor 1 Woche' : `vor ${weeks} Wochen`;
  }
  const months = Math.floor(days / 30);
  if (months < 12) {
    return months === 1 ? 'vor 1 Monat' : `vor ${months} Monaten`;
  }
  const years = Math.floor(days / 365);
  return years === 1 ? 'vor 1 Jahr' : `vor ${years} Jahren`;
}

/** Collapses whitespace and cuts to a preview length. */
export function previewText(text: string, maxLength = 180): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= maxLength) {
    return flat;
  }
  return flat.slice(0, maxLength - 1).trimEnd() + '…';
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Single-quotes a path for a shell command line. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
