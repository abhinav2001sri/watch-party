// -----------------------------------------------------------------------------
// Home - landing page. Create a room (optionally pre-loading a video) or join an
// existing room by code.
// -----------------------------------------------------------------------------

import React, { useState } from 'react';
import { socket } from './socket.js';
import { parseVideoId } from './utils.js';

export default function Home({ onEnterRoom }) {
  const [videoInput, setVideoInput] = useState('');
  const [joinCode, setJoinCode] = useState('');
  const [error, setError] = useState('');

  function handleCreate() {
    setError('');
    // A video is optional at creation time; users can change it inside the room.
    const videoId = parseVideoId(videoInput);
    if (videoInput.trim() && !videoId) {
      setError('That does not look like a valid YouTube URL or video ID.');
      return;
    }

    socket.emit('createRoom', { videoId }, (res) => {
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

    socket.emit('joinRoom', { roomCode: code }, (res) => {
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
        <h1>🎬 Watch Party</h1>
        <p className="subtitle">
          Watch YouTube together, perfectly in sync. Two people, one room.
        </p>
      </div>

      <div className="cards">
        <div className="card">
          <h2>Create a room</h2>
          <label htmlFor="video">YouTube URL or video ID (optional)</label>
          <input
            id="video"
            type="text"
            placeholder="https://youtu.be/dQw4w9WgXcQ"
            value={videoInput}
            onChange={(e) => setVideoInput(e.target.value)}
          />
          <button className="btn primary" onClick={handleCreate}>
            Create room
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
