// -----------------------------------------------------------------------------
// Small helper utilities shared across the app.
// -----------------------------------------------------------------------------

// Parse a YouTube video ID from many possible input formats:
//   - https://www.youtube.com/watch?v=VIDEOID
//   - https://youtu.be/VIDEOID
//   - https://www.youtube.com/embed/VIDEOID
//   - https://www.youtube.com/shorts/VIDEOID
//   - VIDEOID (raw 11-char id)
// Returns the 11-character video id, or null if nothing valid was found.
export function parseVideoId(input) {
  if (!input) return null;
  const value = input.trim();

  // Raw 11-char video id (letters, digits, - and _).
  if (/^[a-zA-Z0-9_-]{11}$/.test(value)) {
    return value;
  }

  try {
    const url = new URL(value);
    const host = url.hostname.replace(/^www\./, '');

    // youtu.be/VIDEOID
    if (host === 'youtu.be') {
      const id = url.pathname.slice(1).split('/')[0];
      return /^[a-zA-Z0-9_-]{11}$/.test(id) ? id : null;
    }

    if (host === 'youtube.com' || host === 'm.youtube.com' || host === 'music.youtube.com') {
      // watch?v=VIDEOID
      const v = url.searchParams.get('v');
      if (v && /^[a-zA-Z0-9_-]{11}$/.test(v)) return v;

      // /embed/VIDEOID or /shorts/VIDEOID or /v/VIDEOID
      const parts = url.pathname.split('/').filter(Boolean);
      if (parts.length >= 2 && ['embed', 'shorts', 'v'].includes(parts[0])) {
        const id = parts[1];
        return /^[a-zA-Z0-9_-]{11}$/.test(id) ? id : null;
      }
    }
  } catch {
    // Not a URL; fall through.
  }

  // Last-ditch: try to extract an 11-char id from anywhere in the string.
  const match = value.match(/[a-zA-Z0-9_-]{11}/);
  return match ? match[0] : null;
}

// Extract a YouTube playlist ID from a URL (the `list=` query param), e.g.
//   https://www.youtube.com/playlist?list=PLxxxx
//   https://www.youtube.com/watch?v=VIDEOID&list=PLxxxx
// Ignores auto-generated mixes (list ids starting with "RD") which cannot be
// expanded via the Data API. Returns the playlist id, or null.
export function parsePlaylistId(input) {
  if (!input) return null;
  const value = input.trim();
  try {
    const url = new URL(value);
    const list = url.searchParams.get('list');
    if (list && !/^RD/.test(list)) return list;
  } catch {
    // Not a URL.
  }
  return null;
}

// Format seconds as m:ss (or h:mm:ss).
export function formatTime(totalSeconds) {
  if (!isFinite(totalSeconds) || totalSeconds < 0) totalSeconds = 0;
  const s = Math.floor(totalSeconds % 60);
  const m = Math.floor((totalSeconds / 60) % 60);
  const h = Math.floor(totalSeconds / 3600);
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}
