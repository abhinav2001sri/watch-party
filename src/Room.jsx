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
import { useVoiceChat } from './useVoiceChat.js';
import { parseVideoId, parsePlaylistId, formatTime } from './utils.js';

// YouTube player state constants.
const YT_PLAYING = 1;
const YT_PAUSED = 2;
const YT_ENDED = 0;

// Emojis available in the reaction picker.
const EMOJIS = ['❤️', '😂', '🔥', '🎉', '👍', '😮', '😍', '🥳', '👏', '💯', '😢', '🙌', '🎶', '✨', '😎', '💃'];

export default function Room({ roomCode, initialState, onLeave }) {
  const [videoId, setVideoId] = useState(initialState?.videoId || null);
  const [userCount, setUserCount] = useState(initialState?.userCount || 1);
  const [copied, setCopied] = useState(false);
  const [shared, setShared] = useState(false);
  const [drift, setDrift] = useState(0);
  const [syncStatus, setSyncStatus] = useState('Connecting…');
  const [changeVideoInput, setChangeVideoInput] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState('');
  const [queue, setQueue] = useState(initialState?.queue || []);
  const [isPlaying, setIsPlaying] = useState(initialState?.isPlaying || false);
  const [activity, setActivity] = useState('');
  const [floaters, setFloaters] = useState([]); // { id, emoji, left }
  const [messages, setMessages] = useState([]); // { id, mine, name, text, time }
  const [chatInput, setChatInput] = useState('');
  const [chatOpen, setChatOpen] = useState(false);
  const [unread, setUnread] = useState(0);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [soundOpen, setSoundOpen] = useState(false);
  const [volume, setVolume] = useState(100);
  const chatEndRef = useRef(null);
  const emojiWrapRef = useRef(null);
  const soundWrapRef = useRef(null);
  const searchSeqRef = useRef(0);

  // Live voice chat (WebRTC) hook.
  const { inVoice, muted, voiceStatus, peerCount, startVoice, stopVoice, toggleMute } = useVoiceChat();

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
    // Keep the Play/Pause toggle label accurate for local *and* remote changes.
    if (e.data === YT_PLAYING) setIsPlaying(true);
    else if (e.data === YT_PAUSED) setIsPlaying(false);
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

  // Spawn a big burst of floating emojis that flutter up and fade out.
  const spawnFloater = useCallback((emoji) => {
    const count = 16 + Math.floor(Math.random() * 8); // 16–23 emojis
    const batch = [];
    for (let i = 0; i < count; i++) {
      batch.push({
        id: Math.random().toString(36).slice(2),
        emoji,
        left: Math.random() * 92 + 2, // percent across the player
        size: 44 + Math.random() * 66, // 44–110px, very big
        drift: Math.random() * 120 - 60, // horizontal drift in px
        delay: Math.random() * 0.5, // stagger start
        duration: 2.2 + Math.random() * 1.6, // 2.2–3.8s
      });
    }
    setFloaters((f) => [...f, ...batch]);
    const maxLife = 4600;
    const ids = batch.map((b) => b.id);
    window.setTimeout(() => {
      setFloaters((f) => f.filter((x) => !ids.includes(x.id)));
    }, maxLife);
  }, []);

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
    socket.on('reaction', ({ emoji }) => spawnFloater(emoji));
    socket.on('system', (msg) => setActivity(typeof msg === 'string' ? msg : ''));
    socket.on('chat', ({ name, text, time }) => {
      setMessages((m) => [...m, { id: Math.random().toString(36).slice(2), mine: false, name, text, time }]);
      setUnread((u) => (chatOpen ? 0 : u + 1));
    });
    socket.on('peerLeft', () => setSyncStatus('Peer left — waiting for someone…'));

    return () => {
      socket.off('roomState', applyRoomState);
      socket.off('play', applyRemotePlay);
      socket.off('pause', applyRemotePause);
      socket.off('seek', applyRemoteSeek);
      socket.off('userCount', setUserCount);
      socket.off('changeVideo');
      socket.off('queueUpdate');
      socket.off('reaction');
      socket.off('system');
      socket.off('chat');
      socket.off('peerLeft');
    };
  }, [applyRoomState, applyRemotePlay, applyRemotePause, applyRemoteSeek, getPlayer, withRemoteApply, spawnFloater, chatOpen]);

  // Auto-clear the activity line after a few seconds.
  useEffect(() => {
    if (!activity) return;
    const t = window.setTimeout(() => setActivity(''), 4000);
    return () => window.clearTimeout(t);
  }, [activity]);

  // Auto-scroll chat to the newest message.
  useEffect(() => {
    if (chatOpen) chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, chatOpen]);

  // Close the emoji / sound popovers when clicking anywhere outside them.
  useEffect(() => {
    if (!emojiOpen && !soundOpen) return;
    function onDocClick(e) {
      if (emojiOpen && emojiWrapRef.current && !emojiWrapRef.current.contains(e.target)) {
        setEmojiOpen(false);
      }
      if (soundOpen && soundWrapRef.current && !soundWrapRef.current.contains(e.target)) {
        setSoundOpen(false);
      }
    }
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [emojiOpen, soundOpen]);

  // Live search suggestions: debounce typing so results appear as you type.
  useEffect(() => {
    const q = searchQuery.trim();
    if (q.length < 2) {
      searchSeqRef.current++; // cancel any in-flight search
      setSearchResults([]);
      setSearchError('');
      setSearching(false);
      return;
    }
    const t = window.setTimeout(() => runSearch(q), 450);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchQuery]);

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
    setSyncStatus(
      userCount >= 2 ? `Connected — ${userCount} watching` : 'Waiting for others…'
    );
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
  function handlePlayPause() {
    const player = getPlayer();
    if (!player) return;
    if (isPlaying) player.pauseVideo();
    else player.playVideo();
  }
  function handleSyncNow() {
    socket.emit('requestRoomState');
  }
  function applyVolume(v) {
    const vol = Math.max(0, Math.min(100, Math.round(v)));
    setVolume(vol);
    const player = getPlayer();
    if (player) {
      player.setVolume(vol);
      if (vol === 0) player.mute();
      else player.unMute();
    }
  }
  function handleToggleMute() {
    applyVolume(volume === 0 ? 70 : 0);
  }
  function handleChangeVideo() {
    // A pasted playlist link takes priority: expand it into the queue and play.
    const list = parsePlaylistId(changeVideoInput);
    if (list) {
      setChangeVideoInput('');
      socket.emit('addPlaylistToQueue', { list });
      return;
    }
    const id = parseVideoId(changeVideoInput);
    if (!id) return;
    setChangeVideoInput('');
    socket.emit('changeVideo', { videoId: id });
  }
  function handleAddToQueue() {
    // If the input is a playlist, add every video from it.
    const list = parsePlaylistId(changeVideoInput);
    if (list) {
      setChangeVideoInput('');
      socket.emit('addPlaylistToQueue', { list });
      return;
    }
    const id = parseVideoId(changeVideoInput);
    if (!id) return;
    setChangeVideoInput('');
    socket.emit('addToQueue', { videoId: id });
  }
  function runSearch(rawQuery) {
    const q = (rawQuery || '').trim();
    if (!q) {
      setSearchResults([]);
      setSearchError('');
      setSearching(false);
      return;
    }
    const seq = ++searchSeqRef.current;
    setSearching(true);
    setSearchError('');
    socket.emit('searchVideos', { query: q }, (res) => {
      if (seq !== searchSeqRef.current) return; // a newer search superseded this one
      setSearching(false);
      if (!res || !res.ok) {
        setSearchResults([]);
        setSearchError(
          res && res.reason === 'no-key'
            ? 'Search needs a YouTube API key on the server. Pasting links and playlists still works.'
            : 'Search failed — please try again in a moment.'
        );
        return;
      }
      setSearchResults(res.results || []);
      setSearchError((res.results || []).length === 0 ? 'No results. Try different words.' : '');
    });
  }
  function handleSearch() {
    runSearch(searchQuery);
  }
  function handlePlayResult(id) {
    socket.emit('changeVideo', { videoId: id });
    setSearchResults([]);
    setSearchQuery('');
    setSearchError('');
  }
  function handleQueueResult(id) {
    socket.emit('addToQueue', { videoId: id });
  }
  function handleSkip() {
    socket.emit('skipVideo');
  }
  function handleRemoveFromQueue(id) {
    socket.emit('removeFromQueue', { id });
  }

  // Send an emoji reaction: show it locally right away and tell the peer.
  function handleReact(emoji) {
    spawnFloater(emoji);
    socket.emit('reaction', { emoji });
  }

  // Send a chat message: add it locally and relay to the peer.
  function handleSendChat() {
    const text = chatInput.trim();
    if (!text) return;
    setMessages((m) => [...m, { id: Math.random().toString(36).slice(2), mine: true, name: 'You', text, time: Date.now() }]);
    socket.emit('chat', { text });
    setChatInput('');
  }
  function toggleChat() {
    setChatOpen((o) => {
      if (!o) setUnread(0);
      return !o;
    });
  }
  function handleVoiceToggle() {
    if (inVoice) stopVoice();
    else startVoice();
  }

  function handleCopy() {
    navigator.clipboard?.writeText(roomCode).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    });
  }

  // Mobile-friendly share: use the native share sheet when available (opens
  // WhatsApp/Messages/etc.), otherwise fall back to copying the join link.
  function handleShare() {
    const joinUrl = `${window.location.origin}${window.location.pathname}?room=${roomCode}`;
    const shareData = {
      title: 'JamAlong',
      text: `Join my JamAlong room ${roomCode}!`,
      url: joinUrl,
    };
    if (navigator.share) {
      navigator.share(shareData).catch(() => {});
    } else {
      navigator.clipboard?.writeText(joinUrl).then(() => {
        setShared(true);
        window.setTimeout(() => setShared(false), 1500);
      });
    }
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
            {copied ? '✓' : 'Copy'}
          </button>
          <button className="btn tiny primary" onClick={handleShare}>
            {shared ? '✓ Link copied' : '🔗 Share'}
          </button>
        </div>
        <button className="room-brand" onClick={handleLeaveClick} title="Back to home">
          <svg className="brand-mic" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <circle cx="7" cy="5.5" r="3.3" />
            <circle cx="13" cy="5.5" r="3.3" />
            <rect x="6.5" y="2.2" width="7" height="1.6" rx="0.8" />
            <rect x="2" y="8.5" width="14" height="10" rx="1.6" />
            <path d="M16 11.2 L22.5 8 L22.5 19 L16 15.8 Z" />
            <path d="M6 18.5 L10 21 L4 21 Z" />
          </svg>
          JamAlong
        </button>
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
            No video loaded yet. Use <strong>Search</strong> or <strong>Play now</strong> below to start.
          </div>
        )}
        {/* The IFrame API replaces this div with the player iframe. */}
        <div id="yt-player" />

        {/* Floating emoji reactions overlay. */}
        <div className="floaters">
          {floaters.map((f) => (
            <span
              key={f.id}
              className="floater"
              style={{
                left: `${f.left}%`,
                fontSize: `${f.size}px`,
                animationDelay: `${f.delay}s`,
                animationDuration: `${f.duration}s`,
                '--drift': `${f.drift}px`,
              }}
            >
              {f.emoji}
            </span>
          ))}
        </div>

        {/* Activity line (who did what). */}
        {activity && <div className="activity-toast">{activity}</div>}
      </div>

      {/* Playback controls + voice & chat toggles. */}
      <div className="reaction-bar">
        <button
          className="btn play-pause-btn"
          onClick={handlePlayPause}
          disabled={!isReady || !videoId}
          title={isPlaying ? 'Pause for everyone' : 'Play for everyone'}
        >
          {isPlaying ? '⏸ Pause' : '▶ Play'}
        </button>
        <button
          className="btn"
          onClick={handleSkip}
          disabled={queue.length === 0}
          title="Play the next queued video"
        >
          ⏭ Next ({queue.length})
        </button>
        <div className="sound-wrap" ref={soundWrapRef}>
          <button
            className="btn"
            onClick={() => setSoundOpen((o) => !o)}
            title="Adjust volume"
          >
            {volume === 0 ? '🔇' : volume < 50 ? '🔉' : '🔊'} Sound
          </button>
          {soundOpen && (
            <div className="sound-popover">
              <button className="sound-mute" onClick={handleToggleMute} title={volume === 0 ? 'Unmute' : 'Mute'}>
                {volume === 0 ? '🔇' : volume < 50 ? '🔉' : '🔊'}
              </button>
              <input
                type="range"
                min="0"
                max="100"
                value={volume}
                onChange={(e) => applyVolume(Number(e.target.value))}
                aria-label="Volume"
              />
              <span className="sound-value">{volume}</span>
            </div>
          )}
        </div>
        <button className="btn" onClick={handleSyncNow} disabled={!videoId} title="Re-sync with everyone">
          ⟳ Sync Now
        </button>
        <span className="reaction-spacer" />
        <button
          className={`btn tiny voice-btn ${inVoice ? 'on' : ''}`}
          onClick={handleVoiceToggle}
          title="Talk / sing live with everyone in the room"
        >
          {inVoice ? '🎙️ Live' : '🎤 Voice'}
        </button>
        {inVoice && (
          <button className={`btn tiny ${muted ? 'primary' : ''}`} onClick={toggleMute}>
            {muted ? '🔇 Unmute' : '🔊 Mute'}
          </button>
        )}
        <button className="btn tiny chat-toggle" onClick={toggleChat}>
          💬 Chat{unread > 0 ? ` (${unread})` : ''}
        </button>
        <div className="emoji-wrap" ref={emojiWrapRef}>
          <button
            className={`btn tiny emoji-toggle ${emojiOpen ? 'on' : ''}`}
            onClick={() => setEmojiOpen((o) => !o)}
            title="Send emoji reactions"
          >
            😀 Emoji
          </button>
          {emojiOpen && (
            <div className="emoji-popover">
              {EMOJIS.map((e) => (
                <button
                  key={e}
                  className="emoji-pick"
                  onClick={() => handleReact(e)}
                  title={`Send ${e}`}
                >
                  {e}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {inVoice && (
        <div className={`voice-status ${voiceStatus}`}>
          {voiceStatus === 'connected'
            ? `🎙️ Voice connected — talking with ${peerCount} ${peerCount === 1 ? 'person' : 'people'}`
            : '🎙️ Voice on — waiting for others to join voice…'}
        </div>
      )}

      {chatOpen && (
        <div className="chat-panel">
          <div className="chat-panel-header">
            <span className="chat-panel-title">💬 Chat</span>
            <button className="chat-close" onClick={toggleChat} title="Close chat" aria-label="Close chat">✕</button>
          </div>
          <div className="chat-messages">
            {messages.length === 0 ? (
              <div className="chat-empty">Say hi 👋 — chat with everyone in the room.</div>
            ) : (
              messages.map((m) => (
                <div key={m.id} className={`chat-msg ${m.mine ? 'mine' : 'theirs'}`}>
                  {!m.mine && <span className="chat-name">{m.name}</span>}
                  <span className="chat-text">{m.text}</span>
                </div>
              ))
            )}
            <div ref={chatEndRef} />
          </div>
          <div className="chat-input-row">
            <input
              type="text"
              placeholder="Type a message…"
              value={chatInput}
              maxLength={500}
              onChange={(e) => setChatInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleSendChat()}
            />
            <button className="btn primary" onClick={handleSendChat}>Send</button>
          </div>
        </div>
      )}

      <div className="search-box">
        <div className="search-row">
          <input
            type="text"
            placeholder="🔎 Search YouTube for a song or video…"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
          />
          <button
            className="btn primary"
            onClick={handleSearch}
            disabled={searching || !searchQuery.trim()}
          >
            {searching ? 'Searching…' : 'Search'}
          </button>
        </div>
        {searchError && <div className="search-error">{searchError}</div>}
        {searchResults.length > 0 && (
          <ul className="search-results">
            {searchResults.map((r) => (
              <li className="search-result" key={r.videoId}>
                <img className="search-thumb" src={r.thumbnail} alt="" loading="lazy" />
                <div className="search-meta">
                  <span className="search-title">{r.title}</span>
                  <span className="search-channel">{r.channel}</span>
                </div>
                <div className="search-actions">
                  <button className="btn tiny" onClick={() => handleQueueResult(r.videoId)}>
                    ＋ Queue
                  </button>
                  <button className="btn tiny primary" onClick={() => handlePlayResult(r.videoId)}>
                    ▶ Play
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="change-video">
        <input
          type="text"
          placeholder="Paste a YouTube video or playlist URL / ID"
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
          <span className="metric-value">{userCount} / 6</span>
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
