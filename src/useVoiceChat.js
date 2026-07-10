// -----------------------------------------------------------------------------
// useVoiceChat - group WebRTC audio+video (full mesh) for everyone in a room.
//
// Design:
//   * Joining the call (startVoice) only enters the signaling mesh — no media.
//   * Audio and camera are independent toggles, both off by default.
//   * setPeerMuted(id, bool) locally mutes/unmutes a remote peer's audio.
//   * voicePeerIds tracks everyone currently in the call (even audio-only).
//   * Camera toggle mid-call triggers onnegotiationneeded renegotiation.
// -----------------------------------------------------------------------------

import { useCallback, useEffect, useRef, useState } from 'react';
import { socket } from './socket.js';

const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];

export function useVoiceChat() {
  const [inVoice, setInVoice] = useState(false);
  const [audioEnabled, setAudioEnabled] = useState(false);
  const [videoEnabled, setVideoEnabled] = useState(false);
  const [localVideoStream, setLocalVideoStream] = useState(null);
  const [voicePeerIds, setVoicePeerIds] = useState([]); // everyone in call
  const [remoteStreams, setRemoteStreams] = useState({});  // peerId -> video MediaStream
  const [voiceStatus, setVoiceStatus] = useState('off');
  const [peerCount, setPeerCount] = useState(0);

  const inVoiceRef = useRef(false);
  const localAudioStreamRef = useRef(null);
  const localVideoStreamRef = useRef(null);
  const peersRef = useRef(new Map()); // peerId -> { pc, audioEl }

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

  const getOrCreatePeer = useCallback((peerId) => {
    const peers = peersRef.current;
    if (peers.has(peerId)) return peers.get(peerId);

    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

    if (localAudioStreamRef.current) {
      localAudioStreamRef.current.getTracks().forEach((t) =>
        pc.addTrack(t, localAudioStreamRef.current)
      );
    }
    if (localVideoStreamRef.current) {
      localVideoStreamRef.current.getTracks().forEach((t) =>
        pc.addTrack(t, localVideoStreamRef.current)
      );
    }

    pc.onicecandidate = (e) => {
      if (e.candidate) socket.emit('voice-ice', { to: peerId, candidate: e.candidate });
    };

    pc.onnegotiationneeded = async () => {
      try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        socket.emit('voice-offer', { to: peerId, sdp: pc.localDescription });
      } catch { /* ignore */ }
    };

    const audioEl = document.createElement('audio');
    audioEl.autoplay = true;
    audioEl.playsInline = true;
    document.body.appendChild(audioEl);

    pc.ontrack = (e) => {
      const stream = e.streams[0];
      if (!stream) return;
      if (e.track.kind === 'audio') {
        audioEl.srcObject = stream;
      } else if (e.track.kind === 'video') {
        setRemoteStreams((prev) => ({ ...prev, [peerId]: stream }));
      }
    };

    pc.onconnectionstatechange = () => { refreshStatus(); };

    const entry = { pc, audioEl };
    peers.set(peerId, entry);
    setVoicePeerIds((prev) => (prev.includes(peerId) ? prev : [...prev, peerId]));
    return entry;
  }, [refreshStatus]);

  const removePeer = useCallback((peerId) => {
    const entry = peersRef.current.get(peerId);
    if (!entry) return;
    try { entry.pc.close(); } catch { /* ignore */ }
    if (entry.audioEl) { entry.audioEl.srcObject = null; entry.audioEl.remove(); }
    peersRef.current.delete(peerId);
    setVoicePeerIds((prev) => prev.filter((id) => id !== peerId));
    setRemoteStreams((prev) => { const n = { ...prev }; delete n[peerId]; return n; });
    refreshStatus();
  }, [refreshStatus]);

  const startVoice = useCallback(() => {
    inVoiceRef.current = true;
    setInVoice(true);
    setVoiceStatus('connecting');
    socket.emit('voice-join');
  }, []);

  const stopVoice = useCallback(() => {
    socket.emit('voice-leave');
    peersRef.current.forEach(({ pc, audioEl }) => {
      try { pc.close(); } catch { /* ignore */ }
      if (audioEl) { audioEl.srcObject = null; audioEl.remove(); }
    });
    peersRef.current.clear();
    if (localAudioStreamRef.current) {
      localAudioStreamRef.current.getTracks().forEach((t) => t.stop());
      localAudioStreamRef.current = null;
    }
    if (localVideoStreamRef.current) {
      localVideoStreamRef.current.getTracks().forEach((t) => t.stop());
      localVideoStreamRef.current = null;
    }
    inVoiceRef.current = false;
    setInVoice(false);
    setAudioEnabled(false);
    setVideoEnabled(false);
    setLocalVideoStream(null);
    setPeerCount(0);
    setVoiceStatus('off');
    setVoicePeerIds([]);
    setRemoteStreams({});
  }, []);

  const toggleAudio = useCallback(async () => {
    if (audioEnabled) {
      if (localAudioStreamRef.current) {
        const tracks = localAudioStreamRef.current.getAudioTracks();
        peersRef.current.forEach(({ pc }) => {
          pc.getSenders().forEach((s) => {
            if (s.track && tracks.includes(s.track)) pc.removeTrack(s);
          });
        });
        localAudioStreamRef.current.getTracks().forEach((t) => t.stop());
        localAudioStreamRef.current = null;
      }
      setAudioEnabled(false);
    } else {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
        localAudioStreamRef.current = stream;
        peersRef.current.forEach(({ pc }) => {
          stream.getAudioTracks().forEach((t) => pc.addTrack(t, stream));
        });
        setAudioEnabled(true);
      } catch {
        alert('Could not access your microphone. Please allow mic permission and try again.');
      }
    }
  }, [audioEnabled]);

  const toggleCamera = useCallback(async () => {
    if (videoEnabled) {
      if (localVideoStreamRef.current) {
        const tracks = localVideoStreamRef.current.getVideoTracks();
        peersRef.current.forEach(({ pc }) => {
          pc.getSenders().forEach((s) => {
            if (s.track && tracks.includes(s.track)) pc.removeTrack(s);
          });
        });
        localVideoStreamRef.current.getTracks().forEach((t) => t.stop());
        localVideoStreamRef.current = null;
      }
      setVideoEnabled(false);
      setLocalVideoStream(null);
    } else {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
        localVideoStreamRef.current = stream;
        peersRef.current.forEach(({ pc }) => {
          stream.getVideoTracks().forEach((t) => pc.addTrack(t, stream));
        });
        setVideoEnabled(true);
        setLocalVideoStream(stream);
      } catch {
        alert('Could not access your camera. Please allow camera permission and try again.');
      }
    }
  }, [videoEnabled]);

  const setPeerMuted = useCallback((peerId, shouldMute) => {
    const entry = peersRef.current.get(peerId);
    if (entry?.audioEl) entry.audioEl.muted = shouldMute;
  }, []);

  useEffect(() => {
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

    const onPeerLeft = ({ id } = {}) => { if (id) removePeer(id); };

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

  useEffect(() => () => {
    peersRef.current.forEach(({ pc, audioEl }) => {
      try { pc.close(); } catch { /* ignore */ }
      if (audioEl) audioEl.remove();
    });
    peersRef.current.clear();
    if (localAudioStreamRef.current) localAudioStreamRef.current.getTracks().forEach((t) => t.stop());
    if (localVideoStreamRef.current) localVideoStreamRef.current.getTracks().forEach((t) => t.stop());
  }, []);

  return {
    inVoice, voiceStatus, peerCount,
    audioEnabled, videoEnabled, localVideoStream,
    voicePeerIds, remoteStreams,
    startVoice, stopVoice,
    toggleAudio, toggleCamera, setPeerMuted,
  };
}
