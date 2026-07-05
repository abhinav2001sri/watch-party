// -----------------------------------------------------------------------------
// Home - landing page. Create a room (optionally pre-loading a video) or join an
// existing room by code.
// -----------------------------------------------------------------------------

import React, { useState } from 'react';
import { socket } from './socket.js';

export default function Home({ onEnterRoom }) {
  const [joinCode, setJoinCode] = useState('');
  const [name, setName] = useState(() => localStorage.getItem('wp_name') || '');
  const [error, setError] = useState('');

  // Persist the chosen display name for next time.
  function rememberName(n) {
    setName(n);
    localStorage.setItem('wp_name', n);
  }

  function handleCreate() {
    setError('');
    socket.emit('createRoom', { videoId: null, name: name.trim() || 'Guest' }, (res) => {
      if (res && res.ok) {
        onEnterRoom(res.roomCode, res.state);
      } else {
        setError((res && res.error) || 'Failed to create room.');
      }
    });
  }

  function handleJoin() {
    setError('');
    const code = joinCode.toUpperCase().trim();
    if (!code) {
      setError('Enter a room code to join.');
      return;
    }

    socket.emit('joinRoom', { roomCode: code, name: name.trim() || 'Guest' }, (res) => {
      if (res && res.ok) {
        onEnterRoom(res.roomCode, res.state);
      } else {
        setError((res && res.error) || 'Failed to join room.');
      }
    });
  }

  return (
    <div className="home">
      <div className="hero">
        <h1>
          <svg className="brand-mic" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <circle cx="7" cy="5.5" r="3.3" />
            <circle cx="13" cy="5.5" r="3.3" />
            <rect x="6.5" y="2.2" width="7" height="1.6" rx="0.8" />
            <rect x="2" y="8.5" width="14" height="10" rx="1.6" />
            <path d="M16 11.2 L22.5 8 L22.5 19 L16 15.8 Z" />
            <path d="M6 18.5 L10 21 L4 21 Z" />
          </svg>
          JamAlong
        </h1>
      </div>

      <div className="name-field">
        <label htmlFor="name">Your name</label>
        <input
          id="name"
          type="text"
          placeholder="What should we call you?"
          value={name}
          maxLength={20}
          onChange={(e) => rememberName(e.target.value)}
        />
      </div>

      <div className="cards">
        <div className="card">
          <h2>Create an instant room</h2>
          <p className="card-hint">Start a fresh room now — add songs and invite friends once you're inside.</p>
          <button className="btn primary" onClick={handleCreate}>
            Create instant room
          </button>
        </div>

        <div className="divider"><span>or</span></div>

        <div className="card">
          <h2>Join a room</h2>
          <label htmlFor="code">Room code</label>
          <input
            id="code"
            type="text"
            placeholder="e.g. K7QM2"
            value={joinCode}
            maxLength={5}
            onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
            onKeyDown={(e) => e.key === 'Enter' && handleJoin()}
          />
          <button className="btn" onClick={handleJoin}>
            Join room
          </button>
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}

      <footer className="home-footer">
        Server-authoritative timing keeps both devices closely synchronized.
      </footer>
    </div>
  );
}
