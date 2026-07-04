// -----------------------------------------------------------------------------
// useVoiceChat - 1:1 WebRTC audio between the two people in a room.
//
// The server (see server.js) is only a signaling relay: it forwards SDP
// offers/answers and ICE candidates. Actual audio flows peer-to-peer.
//
// Flow:
//   * User A clicks the mic button  -> getUserMedia(audio) -> emit 'voice-join'.
//   * When B also joins, the server tells the *newcomer* to 'voice-initiate'.
//   * The initiator creates an offer -> 'voice-offer' -> peer answers -> connected.
//   * ICE candidates are exchanged via 'voice-ice' as they are discovered.
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

  const pcRef = useRef(null);
  const localStreamRef = useRef(null);
  const remoteAudioRef = useRef(null);

  // Lazily create the <audio> element that plays the remote peer's voice.
  function ensureRemoteAudio() {
    if (!remoteAudioRef.current) {
      const el = document.createElement('audio');
      el.autoplay = true;
      el.playsInline = true;
      document.body.appendChild(el);
      remoteAudioRef.current = el;
    }
    return remoteAudioRef.current;
  }

  // Build a fresh RTCPeerConnection wired to the current signaling socket.
  const createPeer = useCallback(() => {
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

    // Send our local audio tracks to the peer.
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((t) => pc.addTrack(t, localStreamRef.current));
    }

    // Relay ICE candidates to the peer as they're found.
    pc.onicecandidate = (e) => {
      if (e.candidate) socket.emit('voice-ice', { candidate: e.candidate });
    };

    // Play the remote audio when it arrives.
    pc.ontrack = (e) => {
      const el = ensureRemoteAudio();
      el.srcObject = e.streams[0];
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'connected') setVoiceStatus('connected');
      else if (['failed', 'disconnected', 'closed'].includes(pc.connectionState)) {
        setVoiceStatus(inVoice ? 'connecting' : 'off');
      }
    };

    pcRef.current = pc;
    return pc;
  }, [inVoice]);

  // Start voice: request mic, then announce we're in voice.
  const startVoice = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      localStreamRef.current = stream;
      setInVoice(true);
      setMuted(false);
      setVoiceStatus('connecting');
      socket.emit('voice-join');
    } catch {
      setVoiceStatus('off');
      alert('Could not access your microphone. Please allow mic permission and try again.');
    }
  }, []);

  // Stop voice: tear everything down and tell the peer.
  const stopVoice = useCallback(() => {
    socket.emit('voice-leave');
    if (pcRef.current) { pcRef.current.close(); pcRef.current = null; }
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((t) => t.stop());
      localStreamRef.current = null;
    }
    if (remoteAudioRef.current) remoteAudioRef.current.srcObject = null;
    setInVoice(false);
    setMuted(false);
    setVoiceStatus('off');
  }, []);

  const toggleMute = useCallback(() => {
    const stream = localStreamRef.current;
    if (!stream) return;
    const next = !muted;
    stream.getAudioTracks().forEach((t) => { t.enabled = !next; });
    setMuted(next);
  }, [muted]);

  // Signaling listeners.
  useEffect(() => {
    // We are the newcomer -> create and send the offer.
    const onInitiate = async () => {
      const pc = createPeer();
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      socket.emit('voice-offer', { sdp: offer });
    };

    // We received an offer -> answer it.
    const onOffer = async ({ sdp }) => {
      const pc = pcRef.current || createPeer();
      await pc.setRemoteDescription(new RTCSessionDescription(sdp));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      socket.emit('voice-answer', { sdp: answer });
    };

    const onAnswer = async ({ sdp }) => {
      const pc = pcRef.current;
      if (pc) await pc.setRemoteDescription(new RTCSessionDescription(sdp));
    };

    const onIce = async ({ candidate }) => {
      const pc = pcRef.current;
      if (pc && candidate) {
        try { await pc.addIceCandidate(new RTCIceCandidate(candidate)); } catch { /* ignore */ }
      }
    };

    const onPeerLeft = () => {
      if (pcRef.current) { pcRef.current.close(); pcRef.current = null; }
      if (remoteAudioRef.current) remoteAudioRef.current.srcObject = null;
      if (inVoice) setVoiceStatus('connecting'); // wait for peer to rejoin
    };

    socket.on('voice-initiate', onInitiate);
    socket.on('voice-offer', onOffer);
    socket.on('voice-answer', onAnswer);
    socket.on('voice-ice', onIce);
    socket.on('voice-peer-left', onPeerLeft);

    return () => {
      socket.off('voice-initiate', onInitiate);
      socket.off('voice-offer', onOffer);
      socket.off('voice-answer', onAnswer);
      socket.off('voice-ice', onIce);
      socket.off('voice-peer-left', onPeerLeft);
    };
  }, [createPeer, inVoice]);

  // Clean up on unmount.
  useEffect(() => () => {
    if (pcRef.current) pcRef.current.close();
    if (localStreamRef.current) localStreamRef.current.getTracks().forEach((t) => t.stop());
    if (remoteAudioRef.current) remoteAudioRef.current.remove();
  }, []);

  return { inVoice, muted, voiceStatus, startVoice, stopVoice, toggleMute };
}
