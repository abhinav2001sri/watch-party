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

      playerRef.current = new YT.Player(elementId, {
        videoId: videoId || undefined,
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
      });
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
