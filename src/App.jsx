// -----------------------------------------------------------------------------
// App - top-level component. Switches between the Home screen and a Room, and
// shows a "Room is full" banner if the server rejects a join.
// -----------------------------------------------------------------------------

import React, { useEffect, useState } from 'react';
import Home from './Home.jsx';
import Room from './Room.jsx';
import JamalongRoom from './JamalongRoom.jsx';
import { socket, startClockSync } from './socket.js';

export default function App() {
  const [room, setRoom] = useState(null); // { code, state, mode }
  const [banner, setBanner] = useState('');

  useEffect(() => {
    // Begin estimating the client<->server clock offset as soon as we mount.
    startClockSync();

    const onRoomFull = () => setBanner('Room is full — up to six people can join this room.');
    const onError = (msg) => setBanner(typeof msg === 'string' ? msg : 'Something went wrong.');

    socket.on('roomFull', onRoomFull);
    socket.on('errorMessage', onError);
    return () => {
      socket.off('roomFull', onRoomFull);
      socket.off('errorMessage', onError);
    };
  }, []);

  // Auto-join a room if the URL contains ?room=CODE (one-click join links).
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const code = (params.get('room') || '').toUpperCase().trim();
    if (!code) return;

    const tryJoin = () => {
      socket.emit('joinRoom', { roomCode: code }, (res) => {
        if (res && res.ok) enterRoom(res.roomCode, res.state, res.state?.mode);
        else setBanner((res && res.error) || 'Could not join that room.');
      });
    };

    if (socket.connected) tryJoin();
    else socket.once('connect', tryJoin);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-dismiss the banner after a few seconds.
  useEffect(() => {
    if (!banner) return;
    const t = window.setTimeout(() => setBanner(''), 4000);
    return () => window.clearTimeout(t);
  }, [banner]);

  function enterRoom(code, state, mode) {
    setBanner('');
    const finalMode = mode || state?.mode || 'youtube';
    setRoom({ code, state, mode: finalMode });
    // Reflect the room in the URL so it's shareable and the back button works.
    const url = `${window.location.pathname}?room=${code}`;
    window.history.replaceState({}, '', url);
  }

  function leaveRoom() {
    setRoom(null);
    window.history.replaceState({}, '', window.location.pathname);
  }

  return (
    <div className="app">
      <BackgroundFloaters />
      {banner && <div className="global-banner">{banner}</div>}
      {room ? (
        room.mode === 'jamalong' ? (
          <JamalongRoom roomCode={room.code} initialState={room.state} onLeave={leaveRoom} />
        ) : (
          <Room roomCode={room.code} initialState={room.state} onLeave={leaveRoom} />
        )
      ) : (
        <Home onEnterRoom={enterRoom} />
      )}
    </div>
  );
}

// A calm layer of flying music notes + fun emojis drifting up the background.
// A good number of them (not a wall), each with its own lane, size, speed and
// delay so the motion feels organic. Purely decorative (pointer-events: none).
const BG_EMOJIS = [
  '🎵', '🎶', '🎬', '🍿', '🎧', '🎤', '⭐', '✨',
  '🎵', '🎶', '💜', '🎸', '🎹', '🌈', '🎵', '🎶',
  '🎼', '💫', '🎧', '🎵',
];

function BackgroundFloaters() {
  // Compute stable, spread-out props once per mount.
  const items = React.useMemo(
    () =>
      BG_EMOJIS.map((emoji, i) => {
        const left = (i * 100) / BG_EMOJIS.length + (Math.random() * 4 - 2); // spread across width
        const size = 22 + Math.round(Math.random() * 26); // 22–48px
        const duration = 16 + Math.random() * 16; // 16–32s
        const delay = -Math.random() * 32; // negative so they're mid-flight on load
        const drift = `${Math.round(Math.random() * 60 - 30)}px`; // horizontal sway
        return { emoji, left, size, duration, delay, drift, key: i };
      }),
    []
  );

  return (
    <div className="bg-floaters" aria-hidden="true">
      {items.map((it) => (
        <span
          key={it.key}
          className="bg-floater"
          style={{
            left: `${it.left}%`,
            fontSize: `${it.size}px`,
            animationDuration: `${it.duration}s`,
            animationDelay: `${it.delay}s`,
            '--drift': it.drift,
          }}
        >
          {it.emoji}
        </span>
      ))}
    </div>
  );
}
