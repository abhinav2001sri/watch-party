// -----------------------------------------------------------------------------
// useYouTubePlayer - a small React hook wrapping the YouTube IFrame Player API.
//
// The IFrame API script is loaded in index.html. When the API finishes loading
// it calls the global `onYouTubeIframeAPIReady`. We queue player creation until
// the API is available.
// -----------------------------------------------------------------------------

import { useEffect, useRef, useState, useCallback } from 'react';

// Resolve once the global YT object + Player constructor are ready.
function whenYouTubeReady() {
  return new Promise((resolve) => {
    if (window.YT && window.YT.Player) {
      resolve(window.YT);
      return;
    }
    // Chain onto any existing handler so we don't clobber it.
    const previous = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      if (typeof previous === 'function') previous();
      resolve(window.YT);
    };
  });
}

export function useYouTubePlayer({ elementId, videoId, onStateChange, onReady }) {
  const playerRef = useRef(null);
  const [isReady, setIsReady] = useState(false);

  // Keep the latest callbacks in refs so we don't recreate the player on every render.
  const onStateChangeRef = useRef(onStateChange);
  const onReadyRef = useRef(onReady);
  useEffect(() => { onStateChangeRef.current = onStateChange; }, [onStateChange]);
  useEffect(() => { onReadyRef.current = onReady; }, [onReady]);

  useEffect(() => {
    let cancelled = false;

    whenYouTubeReady().then((YT) => {
      if (cancelled) return;

      // Build the config. IMPORTANT: only include `videoId` when we actually
      // have one. Passing `videoId: undefined` (or an empty string) makes the
      // IFrame API throw "Invalid video id" and the player never fires its
      // `onReady` event, leaving it permanently unusable. Rooms that start
      // empty (instant rooms) must therefore omit the key entirely and load
      // the first video imperatively via cueVideoById/loadVideoById later.
      const config = {
        playerVars: {
          // Show native controls; allow the app's custom buttons too.
          controls: 1,
          rel: 0,
          modestbranding: 1,
          playsinline: 1,
          origin: window.location.origin,
        },
        events: {
          onReady: () => {
            setIsReady(true);
            if (onReadyRef.current) onReadyRef.current(playerRef.current);
          },
          onStateChange: (e) => {
            if (onStateChangeRef.current) onStateChangeRef.current(e);
          },
        },
      };
      if (videoId) config.videoId = videoId;

      playerRef.current = new YT.Player(elementId, config);
    });

    return () => {
      cancelled = true;
      if (playerRef.current && playerRef.current.destroy) {
        playerRef.current.destroy();
        playerRef.current = null;
      }
    };
    // Intentionally only create the player once (videoId changes are handled
    // imperatively via player.loadVideoById elsewhere).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [elementId]);

  const getPlayer = useCallback(() => playerRef.current, []);

  return { getPlayer, isReady };
}
