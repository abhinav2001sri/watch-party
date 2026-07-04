// -----------------------------------------------------------------------------
// useVoiceChat - group WebRTC audio (full mesh) for everyone in a room.
//
// The server (see server.js) is only a signaling relay: it forwards SDP
// offers/answers and ICE candidates between specific peers by socket id. Actual
// audio flows peer-to-peer. Each participant holds one RTCPeerConnection to
// every other participant.
//
// Flow:
//   * User clicks the mic button -> getUserMedia(audio) -> emit 'voice-join'.
//   * Server replies 'voice-peers' with the ids already in voice; we create an
//     offer to each of them ('voice-offer' {to}).
//   * Each existing peer receives 'voice-offer' {from}, answers it, and audio
//     connects. ICE candidates are exchanged per-peer via 'voice-ice' {to}.
//   * 'voice-peer-left' {id} tears down just that one peer connection.
//
// Note: public STUN servers handle most home networks. Very strict/symmetric
// NATs may require a TURN server (not included) — documented in the README.
// -----------------------------------------------------------------------------

import { useCallback, useEffect, useRef, useState } from 'react';
import { socket } from './socket.js';

const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];

export function useVoiceChat() {
  const [inVoice, setInVoice] = useState(false);
  const [muted, setMuted] = useState(false);
  const [voiceStatus, setVoiceStatus] = useState('off'); // off | connecting | connected
  const [peerCount, setPeerCount] = useState(0); // how many peers we're connected to

  const inVoiceRef = useRef(false); // synchronous mirror of inVoice for listeners
  const localStreamRef = useRef(null);
  const peersRef = useRef(new Map()); // peerId -> { pc, audioEl }

  // Recompute the aggregate voice status from all peer connection states.
  const refreshStatus = useCallback(() => {
    const peers = peersRef.current;
    setPeerCount(peers.size);
    if (!inVoiceRef.current) { setVoiceStatus('off'); return; }
    if (peers.size === 0) { setVoiceStatus('connecting'); return; }
    let anyConnected = false;
    peers.forEach(({ pc }) => {
      if (pc.connectionState === 'connected') anyConnected = true;
    });
    setVoiceStatus(anyConnected ? 'connected' : 'connecting');
  }, []);

  // Create (or fetch) the peer connection + audio element for a given peer id.
  const getOrCreatePeer = useCallback((peerId) => {
    const peers = peersRef.current;
    if (peers.has(peerId)) return peers.get(peerId);

    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

    // Send our local audio tracks to this peer.
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((t) => pc.addTrack(t, localStreamRef.current));
    }

    // Relay ICE candidates to this specific peer.
    pc.onicecandidate = (e) => {
      if (e.candidate) socket.emit('voice-ice', { to: peerId, candidate: e.candidate });
    };

    // Play this peer's remote audio through its own <audio> element.
    const audioEl = document.createElement('audio');
    audioEl.autoplay = true;
    audioEl.playsInline = true;
    document.body.appendChild(audioEl);

    pc.ontrack = (e) => { audioEl.srcObject = e.streams[0]; };

    pc.onconnectionstatechange = () => { refreshStatus(); };

    const entry = { pc, audioEl };
    peers.set(peerId, entry);
    return entry;
  }, [refreshStatus]);

  // Tear down a single peer connection.
  const removePeer = useCallback((peerId) => {
    const peers = peersRef.current;
    const entry = peers.get(peerId);
    if (!entry) return;
    try { entry.pc.close(); } catch { /* ignore */ }
    if (entry.audioEl) { entry.audioEl.srcObject = null; entry.audioEl.remove(); }
    peers.delete(peerId);
    refreshStatus();
  }, [refreshStatus]);

  // Start voice: request mic, then announce we're in voice.
  const startVoice = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      localStreamRef.current = stream;
      inVoiceRef.current = true;
      setInVoice(true);
      setMuted(false);
      setVoiceStatus('connecting');
      socket.emit('voice-join');
    } catch {
      setVoiceStatus('off');
      alert('Could not access your microphone. Please allow mic permission and try again.');
    }
  }, []);

  // Stop voice: tear down every peer connection and tell the room.
  const stopVoice = useCallback(() => {
    socket.emit('voice-leave');
    peersRef.current.forEach((entry) => {
      try { entry.pc.close(); } catch { /* ignore */ }
      if (entry.audioEl) { entry.audioEl.srcObject = null; entry.audioEl.remove(); }
    });
    peersRef.current.clear();
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((t) => t.stop());
      localStreamRef.current = null;
    }
    inVoiceRef.current = false;
    setInVoice(false);
    setMuted(false);
    setPeerCount(0);
    setVoiceStatus('off');
  }, []);

  const toggleMute = useCallback(() => {
    const stream = localStreamRef.current;
    if (!stream) return;
    const next = !muted;
    stream.getAudioTracks().forEach((t) => { t.enabled = !next; });
    setMuted(next);
  }, [muted]);

  // Signaling listeners (mesh).
  useEffect(() => {
    // Server told us who's already in voice -> we offer to each of them.
    const onPeers = async ({ peers = [] }) => {
      for (const peerId of peers) {
        const { pc } = getOrCreatePeer(peerId);
        try {
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          socket.emit('voice-offer', { to: peerId, sdp: offer });
        } catch { /* ignore */ }
      }
      refreshStatus();
    };

    // A peer sent us an offer -> answer it.
    const onOffer = async ({ from, sdp }) => {
      if (!from) return;
      const { pc } = getOrCreatePeer(from);
      try {
        await pc.setRemoteDescription(new RTCSessionDescription(sdp));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        socket.emit('voice-answer', { to: from, sdp: answer });
      } catch { /* ignore */ }
    };

    const onAnswer = async ({ from, sdp }) => {
      const entry = peersRef.current.get(from);
      if (entry) {
        try { await entry.pc.setRemoteDescription(new RTCSessionDescription(sdp)); } catch { /* ignore */ }
      }
    };

    const onIce = async ({ from, candidate }) => {
      const entry = peersRef.current.get(from);
      if (entry && candidate) {
        try { await entry.pc.addIceCandidate(new RTCIceCandidate(candidate)); } catch { /* ignore */ }
      }
    };

    const onPeerLeft = ({ id } = {}) => {
      if (id) removePeer(id);
    };

    socket.on('voice-peers', onPeers);
    socket.on('voice-offer', onOffer);
    socket.on('voice-answer', onAnswer);
    socket.on('voice-ice', onIce);
    socket.on('voice-peer-left', onPeerLeft);

    return () => {
      socket.off('voice-peers', onPeers);
      socket.off('voice-offer', onOffer);
      socket.off('voice-answer', onAnswer);
      socket.off('voice-ice', onIce);
      socket.off('voice-peer-left', onPeerLeft);
    };
  }, [getOrCreatePeer, removePeer, refreshStatus]);

  // Clean up on unmount.
  useEffect(() => () => {
    peersRef.current.forEach((entry) => {
      try { entry.pc.close(); } catch { /* ignore */ }
      if (entry.audioEl) entry.audioEl.remove();
    });
    peersRef.current.clear();
    if (localStreamRef.current) localStreamRef.current.getTracks().forEach((t) => t.stop());
  }, []);

  return { inVoice, muted, voiceStatus, peerCount, startVoice, stopVoice, toggleMute };
}
