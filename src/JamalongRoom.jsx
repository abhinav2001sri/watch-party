import React, { useEffect, useMemo, useRef, useState } from 'react';
import { socket } from './socket.js';
import { useJamalongCall } from './useJamalongCall.js';

function StreamView({ stream, muted = false, className = '', emptyLabel = 'Camera off' }) {
  const ref = useRef(null);
  useEffect(() => {
    if (ref.current) ref.current.srcObject = stream || null;
  }, [stream]);

  if (!stream) {
    return <div className={`jam-video-blank ${className}`}>{emptyLabel}</div>;
  }

  return <video ref={ref} autoPlay playsInline muted={muted} className={className} />;
}

function ParticipantTile({ label, stream, mine = false }) {
  return (
    <div className="jam-tile">
      <StreamView stream={stream} muted={mine} className="jam-tile-video" />
      <div className="jam-tile-label">{label}</div>
    </div>
  );
}

export default function JamalongRoom({ roomCode, initialState, onLeave }) {
  const [userCount, setUserCount] = useState(initialState?.userCount || 1);
  const [copied, setCopied] = useState(false);
  const [shared, setShared] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [messages, setMessages] = useState([]);
  const [chatInput, setChatInput] = useState('');
  const [systemLine, setSystemLine] = useState('Jamalong ready. You are now in the call.');
  const [isFullscreen, setIsFullscreen] = useState(false);
  const chatEndRef = useRef(null);
  const roomRootRef = useRef(null);

  const {
    micEnabled,
    cameraEnabled,
    screenSharing,
    screenAudioShared,
    callStatus,
    peerIds,
    remoteCameraStreams,
    remoteScreenStreams,
    activeScreenSharers,
    localCameraStream,
    localScreenStream,
    startCall,
    leaveCall,
    toggleMic,
    toggleCamera,
    toggleScreenShare,
  } = useJamalongCall();

  const stageStream = useMemo(() => {
    if (screenSharing && localScreenStream) return localScreenStream;
    const remoteSharerId = peerIds.find((id) => activeScreenSharers[id] && remoteScreenStreams[id]);
    if (remoteSharerId) return remoteScreenStreams[remoteSharerId];
    const firstRemote = peerIds.find((id) => {
      const s = remoteCameraStreams[id];
      return s && s.getVideoTracks().length > 0;
    });
    if (firstRemote) return remoteCameraStreams[firstRemote];
    if (localCameraStream) return localCameraStream;
    return null;
  }, [activeScreenSharers, localCameraStream, localScreenStream, peerIds, remoteCameraStreams, remoteScreenStreams, screenSharing]);

  useEffect(() => {
    socket.on('userCount', setUserCount);
    socket.on('system', (msg) => {
      if (typeof msg === 'string') setSystemLine(msg);
    });
    socket.on('chat', ({ name, text, time }) => {
      setMessages((prev) => [...prev, { id: Math.random().toString(36).slice(2), mine: false, name, text, time }]);
    });

    return () => {
      socket.off('userCount', setUserCount);
      socket.off('system');
      socket.off('chat');
    };
  }, []);

  useEffect(() => {
    if (chatOpen) chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [chatOpen, messages]);

  useEffect(() => {
    function onFsChange() {
      setIsFullscreen(Boolean(document.fullscreenElement));
    }
    document.addEventListener('fullscreenchange', onFsChange);
    return () => document.removeEventListener('fullscreenchange', onFsChange);
  }, []);

  useEffect(() => {
    startCall();
    return () => {
      leaveCall();
    };
  }, [leaveCall, startCall]);

  function handleShareRoom() {
    const joinUrl = `${window.location.origin}${window.location.pathname}?room=${roomCode}`;
    const shareData = {
      title: 'Jamalong',
      text: `Join my Jamalong room ${roomCode}!`,
      url: joinUrl,
    };
    if (navigator.share) {
      navigator.share(shareData).catch(() => {});
      return;
    }
    navigator.clipboard?.writeText(joinUrl).then(() => {
      setShared(true);
      window.setTimeout(() => setShared(false), 1600);
    });
  }

  function handleCopyCode() {
    navigator.clipboard?.writeText(roomCode).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    });
  }

  function handleLeaveRoom() {
    leaveCall();
    socket.emit('leaveRoom');
    onLeave();
  }

  function sendChat() {
    const text = chatInput.trim();
    if (!text) return;
    setMessages((prev) => [...prev, { id: Math.random().toString(36).slice(2), mine: true, name: 'You', text, time: Date.now() }]);
    socket.emit('chat', { text });
    setChatInput('');
  }

  async function toggleFullscreen() {
    const el = roomRootRef.current;
    if (!el) return;
    if (!document.fullscreenElement) {
      await el.requestFullscreen?.();
      return;
    }
    await document.exitFullscreen?.();
  }

  const remoteTiles = peerIds.map((peerId, index) => (
    <ParticipantTile key={peerId} label={`Guest ${index + 1}`} stream={remoteCameraStreams[peerId] || null} />
  ));

  return (
    <div className={`jam-room${isFullscreen ? ' jam-room-fs' : ''}`} ref={roomRootRef}>
      <header className="jam-header">
        <div className="jam-room-meta">
          <span className="jam-chip">Jamalong</span>
          <span className="jam-room-code">Room {roomCode}</span>
          <button className="btn tiny" onClick={handleCopyCode}>{copied ? 'Copied' : 'Copy code'}</button>
          <button className="btn tiny" onClick={handleShareRoom}>{shared ? 'Link copied' : 'Share invite'}</button>
        </div>
        <div className="jam-header-right">
          <span className="jam-status-text">{userCount} in room</span>
          <button className="btn tiny ghost" onClick={handleLeaveRoom}>Leave</button>
        </div>
      </header>

      <section className="jam-stage-wrap">
        <div className="jam-stage">
          <StreamView stream={stageStream} muted className="jam-stage-video" emptyLabel="" />
          {!stageStream && (
            <div className="jam-stage-empty">
              <h3>Ready to jam</h3>
              <p>Turn on your camera or present a tab/window to start.</p>
            </div>
          )}
          <div className="jam-stage-caption">{systemLine}</div>
        </div>

        <aside className="jam-side-panel">
          <h3>Participants</h3>
          <div className="jam-grid">
            {remoteTiles}
            <ParticipantTile label="You" stream={localCameraStream} mine />
          </div>
        </aside>
      </section>

      <div className="jam-controls">
        <button className={`btn ${micEnabled ? 'primary' : ''}`} onClick={toggleMic}>
          {micEnabled ? 'Mic on' : 'Mic off'}
        </button>

        <button className={`btn ${cameraEnabled ? 'primary' : ''}`} onClick={toggleCamera}>
          {cameraEnabled ? 'Camera on' : 'Camera off'}
        </button>

        <button className={`btn ${screenSharing ? 'primary' : ''}`} onClick={toggleScreenShare}>
          {screenSharing ? 'Stop presenting' : 'Present tab/window'}
        </button>

        <button className="btn" onClick={toggleFullscreen}>
          {isFullscreen ? 'Exit full size' : 'Full size'}
        </button>

        <button className="btn" onClick={() => setChatOpen((v) => !v)}>Chat</button>
      </div>

      <div className="jam-help-line">
        {screenSharing
          ? screenAudioShared
            ? 'Sharing with display audio enabled.'
            : 'Sharing video only. If window audio was not available, your browser blocked it for that source.'
          : 'Tip: choose a tab/window and enable Share audio in the picker when available.'}
      </div>

      <div className="jam-help-line">Call status: {callStatus}</div>

      {chatOpen && (
        <div className="chat-panel">
          <div className="chat-panel-header">
            <span className="chat-panel-title">Chat</span>
            <button className="chat-close" onClick={() => setChatOpen(false)} aria-label="Close chat">✕</button>
          </div>
          <div className="chat-messages">
            {messages.length === 0 ? (
              <div className="chat-empty">No messages yet.</div>
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
              value={chatInput}
              placeholder="Type a message"
              onChange={(e) => setChatInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && sendChat()}
            />
            <button className="btn primary" onClick={sendChat}>Send</button>
          </div>
        </div>
      )}
    </div>
  );
}
