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

  // Auto-dismiss the banner after a few seconds.
  useEffect(() => {
    if (!banner) return;
    const t = window.setTimeout(() => setBanner(''), 4000);
    return () => window.clearTimeout(t);
  }, [banner]);

  function enterRoom(code, state) {
    setBanner('');
    setRoom({ code, state });
  }

  function leaveRoom() {
    setRoom(null);
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
