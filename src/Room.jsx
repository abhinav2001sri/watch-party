// -----------------------------------------------------------------------------
// Room - the synchronized watch experience.
//
// This component owns all synchronization logic:
//   * Server is the source of truth. We keep a local mirror of the authoritative
//     state { videoId, isPlaying, currentTime, lastUpdatedServerTime } and use
//     the server clock (serverNow()) to reconstruct the expected video time.
//   * Scheduled playback: play events carry a `startAtServerTime` slightly in the
//     future; both clients seek first, then start exactly at that moment.
//   * Drift correction: every 2s we compare the player's position to the expected
//     position. Large drift (>0.3s) triggers a seek; small drift nudges playbackRate.
//   * Feedback-loop prevention: while applying a remote update we set
//     `isApplyingRemoteUpdate` so our own onStateChange handlers don't rebroadcast.
// -----------------------------------------------------------------------------

import React, { useEffect, useRef, useState, useCallback } from 'react';
import { socket, serverNow, getClockOffset } from './socket.js';
import { useYouTubePlayer } from './useYouTubePlayer.js';
import { parseVideoId, formatTime } from './utils.js';

// YouTube player state constants.
const YT_PLAYING = 1;
const YT_PAUSED = 2;
const YT_ENDED = 0;

export default function Room({ roomCode, initialState, onLeave }) {
  const [videoId, setVideoId] = useState(initialState?.videoId || null);
  const [userCount, setUserCount] = useState(initialState?.userCount || 1);
  const [copied, setCopied] = useState(false);
  const [drift, setDrift] = useState(0);
  const [syncStatus, setSyncStatus] = useState('Connecting…');
  const [changeVideoInput, setChangeVideoInput] = useState('');
  const [queue, setQueue] = useState(initialState?.queue || []);

  // Authoritative state mirror (server time based). Kept in a ref because the
  // drift-correction loop reads it frequently without needing re-renders.
  const serverStateRef = useRef({
    videoId: initialState?.videoId || null,
    isPlaying: initialState?.isPlaying || false,
    currentTime: initialState?.currentTime || 0,
    lastUpdatedServerTime: initialState?.lastUpdatedServerTime || serverNow(),
  });

  // Feedback-loop guard: true while we are applying a remote update so our own
  // player-event handlers don't rebroadcast the change.
  const isApplyingRemoteUpdate = useRef(false);

  // Tracks the player position we last predicted, for local seek detection.
  const lastKnownTimeRef = useRef(0);

  // Compute the expected video position (seconds) right now from server state.
  const expectedTime = useCallback(() => {
    const s = serverStateRef.current;
    if (!s.isPlaying) return s.currentTime;
    return s.currentTime + (serverNow() - s.lastUpdatedServerTime) / 1000;
  }, []);

  // Briefly suppress our own broadcast while we drive the player programmatically.
  const withRemoteApply = useCallback((fn, holdMs = 700) => {
    isApplyingRemoteUpdate.current = true;
    fn();
    window.clearTimeout(withRemoteApply._t);
    withRemoteApply._t = window.setTimeout(() => {
      isApplyingRemoteUpdate.current = false;
    }, holdMs);
  }, []);

  // ---- Player event handlers -------------------------------------------------
  const handleStateChange = useCallback((e) => {
    const player = e.target;
    if (isApplyingRemoteUpdate.current) return; // Don't rebroadcast remote-driven changes.

    const time = player.getCurrentTime();
    lastKnownTimeRef.current = time;

    if (e.data === YT_PLAYING) {
      serverStateRef.current = {
        ...serverStateRef.current,
        isPlaying: true,
        currentTime: time,
        lastUpdatedServerTime: serverNow(),
      };
      socket.emit('play', { currentTime: time });
    } else if (e.data === YT_PAUSED) {
      serverStateRef.current = {
        ...serverStateRef.current,
        isPlaying: false,
        currentTime: time,
        lastUpdatedServerTime: serverNow(),
      };
      socket.emit('pause', { currentTime: time });
    } else if (e.data === YT_ENDED) {
      // Video finished -> ask the server to advance to the next queued video.
      socket.emit('videoEnded', { videoId: serverStateRef.current.videoId });
    }
  }, []);

  const { getPlayer, isReady } = useYouTubePlayer({
    elementId: 'yt-player',
    videoId,
    onStateChange: handleStateChange,
  });

  // ---- Apply remote events to the local player -------------------------------

  // Play: seek to target, then start exactly at startAtServerTime.
  const applyRemotePlay = useCallback(({ currentTime, startAtServerTime }) => {
    const player = getPlayer();
    if (!player) return;

    serverStateRef.current = {
      ...serverStateRef.current,
      isPlaying: true,
      currentTime,
      lastUpdatedServerTime: startAtServerTime,
    };

    const delay = startAtServerTime - serverNow();
    withRemoteApply(() => {
      if (delay > 0) {
        // Seek to the paused position now, then start at the scheduled moment.
        player.seekTo(currentTime, true);
        window.setTimeout(() => {
          isApplyingRemoteUpdate.current = true; // keep suppressed through the play
          player.playVideo();
        }, delay);
      } else {
        // We're late — compensate for the elapsed time and play immediately.
        player.seekTo(currentTime + (-delay) / 1000, true);
        player.playVideo();
      }
    }, Math.max(delay, 0) + 800);
  }, [getPlayer, withRemoteApply]);

  const applyRemotePause = useCallback(({ currentTime }) => {
    const player = getPlayer();
    if (!player) return;

    serverStateRef.current = {
      ...serverStateRef.current,
      isPlaying: false,
      currentTime,
      lastUpdatedServerTime: serverNow(),
    };

    withRemoteApply(() => {
      player.seekTo(currentTime, true);
      player.pauseVideo();
    });
  }, [getPlayer, withRemoteApply]);

  const applyRemoteSeek = useCallback(({ currentTime, isPlaying }) => {
    const player = getPlayer();
    if (!player) return;

    serverStateRef.current = {
      ...serverStateRef.current,
      isPlaying,
      currentTime,
      lastUpdatedServerTime: serverNow(),
    };

    withRemoteApply(() => {
      player.seekTo(currentTime, true);
      if (isPlaying) player.playVideo();
      else player.pauseVideo();
    });
  }, [getPlayer, withRemoteApply]);

  // Apply a full room-state snapshot (used on join / Sync Now).
  const applyRoomState = useCallback((state) => {
    const player = getPlayer();
    setVideoId(state.videoId);
    if (typeof state.userCount === 'number') setUserCount(state.userCount);

    serverStateRef.current = {
      videoId: state.videoId,
      isPlaying: state.isPlaying,
      currentTime: state.currentTime,
      lastUpdatedServerTime: state.lastUpdatedServerTime,
    };

    if (Array.isArray(state.queue)) setQueue(state.queue);

    if (!player || !state.videoId) return;

    withRemoteApply(() => {
      const target = state.isPlaying
        ? state.currentTime + (serverNow() - state.lastUpdatedServerTime) / 1000
        : state.currentTime;
      player.seekTo(target, true);
      if (state.isPlaying) player.playVideo();
      else player.pauseVideo();
    }, 1000);
  }, [getPlayer, withRemoteApply]);

  // ---- Socket wiring ---------------------------------------------------------
  useEffect(() => {
    socket.on('roomState', applyRoomState);
    socket.on('play', applyRemotePlay);
    socket.on('pause', applyRemotePause);
    socket.on('seek', applyRemoteSeek);
    socket.on('userCount', setUserCount);
    socket.on('changeVideo', ({ videoId: newId, autoplay }) => {
      serverStateRef.current = {
        videoId: newId,
        isPlaying: !!autoplay,
        currentTime: 0,
        lastUpdatedServerTime: serverNow(),
      };
      setVideoId(newId);
      const player = getPlayer();
      if (player && newId) {
        withRemoteApply(() => {
          // autoplay -> load & play the next video; otherwise cue it (loaded, paused).
          if (autoplay) player.loadVideoById(newId, 0);
          else player.cueVideoById(newId, 0);
        }, 1200);
      }
    });
    socket.on('queueUpdate', (q) => setQueue(Array.isArray(q) ? q : []));
    socket.on('peerLeft', () => setSyncStatus('Peer left — waiting for someone…'));

    return () => {
      socket.off('roomState', applyRoomState);
      socket.off('play', applyRemotePlay);
      socket.off('pause', applyRemotePause);
      socket.off('seek', applyRemoteSeek);
      socket.off('userCount', setUserCount);
      socket.off('changeVideo');
      socket.off('queueUpdate');
      socket.off('peerLeft');
    };
  }, [applyRoomState, applyRemotePlay, applyRemotePause, applyRemoteSeek, getPlayer, withRemoteApply]);

  // ---- Local seek detection + drift correction loop --------------------------
  useEffect(() => {
    if (!isReady) return;

    // Seek detection: poll frequently and compare the player position to what we
    // predicted. A large unexpected jump means the user dragged the scrubber.
    const seekInterval = window.setInterval(() => {
      const player = getPlayer();
      if (!player || isApplyingRemoteUpdate.current) return;
      const state = player.getPlayerState();
      if (state !== YT_PLAYING && state !== YT_PAUSED) return;

      const actual = player.getCurrentTime();
      const predicted = lastKnownTimeRef.current + (state === YT_PLAYING ? 0.5 : 0);

      if (Math.abs(actual - predicted) > 1.0) {
        // Treat as a user-initiated seek.
        serverStateRef.current = {
          ...serverStateRef.current,
          currentTime: actual,
          lastUpdatedServerTime: serverNow(),
        };
        socket.emit('seek', { currentTime: actual });
      }
      lastKnownTimeRef.current = actual;
    }, 500);

    // Drift correction: every 2s, align the local player to the expected time.
    const driftInterval = window.setInterval(() => {
      const player = getPlayer();
      if (!player) return;
      const s = serverStateRef.current;
      const playerState = player.getPlayerState();

      // Only correct while both server and player agree we should be playing.
      if (!s.isPlaying || playerState !== YT_PLAYING) {
        setDrift(0);
        if (player.getPlaybackRate && player.getPlaybackRate() !== 1) {
          player.setPlaybackRate(1);
        }
        return;
      }

      const expected = expectedTime();
      const actual = player.getCurrentTime();
      const d = actual - expected; // positive => local ahead of server.
      setDrift(d);

      if (Math.abs(d) > 0.3) {
        // Large drift: hard seek to the corrected position.
        withRemoteApply(() => {
          player.seekTo(expected, true);
          player.setPlaybackRate(1);
        }, 400);
      } else if (Math.abs(d) > 0.08 && player.setPlaybackRate) {
        // Small drift: temporarily nudge playbackRate to glide back into sync.
        const rate = d > 0 ? 0.95 : 1.05;
        player.setPlaybackRate(rate);
        window.setTimeout(() => {
          const p = getPlayer();
          if (p && p.setPlaybackRate) p.setPlaybackRate(1);
        }, 1000);
      } else if (player.setPlaybackRate && player.getPlaybackRate() !== 1) {
        player.setPlaybackRate(1);
      }
    }, 2000);

    return () => {
      window.clearInterval(seekInterval);
      window.clearInterval(driftInterval);
    };
  }, [isReady, getPlayer, expectedTime, withRemoteApply]);

  // Connection status text derived from user count.
  useEffect(() => {
    setSyncStatus(userCount >= 2 ? 'Connected — 2 watching' : 'Waiting for second user…');
  }, [userCount]);

  // Leave the room on unmount / tab close.
  useEffect(() => {
    const onUnload = () => socket.emit('leaveRoom');
    window.addEventListener('beforeunload', onUnload);
    return () => window.removeEventListener('beforeunload', onUnload);
  }, []);

  // ---- Custom control button handlers ---------------------------------------
  function handlePlay() {
    const player = getPlayer();
    if (player) player.playVideo(); // triggers onStateChange -> broadcast
  }
  function handlePause() {
    const player = getPlayer();
    if (player) player.pauseVideo();
  }
  function handleSyncNow() {
    socket.emit('requestRoomState');
  }
  function handleChangeVideo() {
    const id = parseVideoId(changeVideoInput);
    if (!id) return;
    setChangeVideoInput('');
    socket.emit('changeVideo', { videoId: id });
  }
  function handleAddToQueue() {
    const id = parseVideoId(changeVideoInput);
    if (!id) return;
    setChangeVideoInput('');
    socket.emit('addToQueue', { videoId: id });
  }
  function handleSkip() {
    socket.emit('skipVideo');
  }
  function handleRemoveFromQueue(id) {
    socket.emit('removeFromQueue', { id });
  }

  function handleCopy() {
    navigator.clipboard?.writeText(roomCode).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    });
  }

  function handleLeaveClick() {
    socket.emit('leaveRoom');
    onLeave();
  }

  return (
    <div className="room">
      <header className="room-header">
        <div className="room-code">
          <span className="label">Room</span>
          <span className="code">{roomCode}</span>
          <button className="btn tiny" onClick={handleCopy}>
            {copied ? '✓ Copied' : 'Copy'}
          </button>
        </div>
        <div className="room-status">
          <span className={`dot ${userCount >= 2 ? 'green' : 'amber'}`} />
          {syncStatus}
        </div>
        <button className="btn tiny ghost" onClick={handleLeaveClick}>
          Leave
        </button>
      </header>

      <div className="player-wrap">
        {!videoId && (
          <div className="no-video">
            No video loaded yet. Use <strong>Change Video</strong> below to start.
          </div>
        )}
        {/* The IFrame API replaces this div with the player iframe. */}
        <div id="yt-player" />
      </div>

      <div className="controls">
        <button className="btn" onClick={handlePlay} disabled={!isReady || !videoId}>▶ Play</button>
        <button className="btn" onClick={handlePause} disabled={!isReady || !videoId}>⏸ Pause</button>
        <button className="btn" onClick={handleSyncNow} disabled={!videoId}>⟳ Sync Now</button>
        <button className="btn" onClick={handleSkip} disabled={queue.length === 0} title="Play the next queued video">
          ⏭ Next ({queue.length})
        </button>
      </div>

      <div className="change-video">
        <input
          type="text"
          placeholder="Paste a YouTube URL or video ID"
          value={changeVideoInput}
          onChange={(e) => setChangeVideoInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleChangeVideo()}
        />
        <button className="btn" onClick={handleAddToQueue}>＋ Add to queue</button>
        <button className="btn primary" onClick={handleChangeVideo}>Play now</button>
      </div>

      <div className="queue">
        <div className="queue-header">
          <span>Up next</span>
          <span className="queue-count">{queue.length} in queue</span>
        </div>
        {queue.length === 0 ? (
          <div className="queue-empty">
            Queue is empty. Paste a link above and hit <strong>Add to queue</strong>.
          </div>
        ) : (
          <ul className="queue-list">
            {queue.map((item, i) => (
              <li className="queue-item" key={item.id}>
                <span className="queue-index">{i + 1}</span>
                <img className="queue-thumb" src={item.thumbnail} alt="" loading="lazy" />
                <span className="queue-title">{item.title}</span>
                <button
                  className="btn tiny ghost"
                  onClick={() => handleRemoveFromQueue(item.id)}
                  title="Remove from queue"
                >
                  ✕
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="metrics">
        <div className="metric">
          <span className="metric-label">Users</span>
          <span className="metric-value">{userCount} / 2</span>
        </div>
        <div className="metric">
          <span className="metric-label">Sync</span>
          <span className="metric-value">{userCount >= 2 ? 'Live' : 'Solo'}</span>
        </div>
        <div className="metric">
          <span className="metric-label">Drift</span>
          <span className={`metric-value ${Math.abs(drift) > 0.3 ? 'warn' : ''}`}>
            {drift >= 0 ? '+' : ''}{drift.toFixed(2)}s
          </span>
        </div>
        <div className="metric">
          <span className="metric-label">Clock offset</span>
          <span className="metric-value">{Math.round(getClockOffset())}ms</span>
        </div>
      </div>
    </div>
  );
}
