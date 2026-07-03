// -----------------------------------------------------------------------------
// App - top-level component. Switches between the Home screen and a Room, and
// shows a "Room is full" banner if the server rejects a join.
// -----------------------------------------------------------------------------

import React, { useEffect, useState } from 'react';
import Home from './Home.jsx';
import Room from './Room.jsx';
import { socket, startClockSync } from './socket.js';

export default function App() {
  const [room, setRoom] = useState(null); // { code, state }
  const [banner, setBanner] = useState('');

  useEffect(() => {
    // Begin estimating the client<->server clock offset as soon as we mount.
    startClockSync();

    const onRoomFull = () => setBanner('Room is full — only two people can watch together.');
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
        if (res && res.ok) enterRoom(res.roomCode, res.state);
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

  function enterRoom(code, state) {
    setBanner('');
    setRoom({ code, state });
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
      {banner && <div className="global-banner">{banner}</div>}
      {room ? (
        <Room roomCode={room.code} initialState={room.state} onLeave={leaveRoom} />
      ) : (
        <Home onEnterRoom={enterRoom} />
      )}
    </div>
  );
}
