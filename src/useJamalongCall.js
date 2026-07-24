import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { socket } from './socket.js';

const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];

export function useJamalongCall() {
  const [inCall, setInCall] = useState(false);
  const [micEnabled, setMicEnabled] = useState(false);
  const [cameraEnabled, setCameraEnabled] = useState(false);
  const [screenSharing, setScreenSharing] = useState(false);
  const [screenAudioShared, setScreenAudioShared] = useState(false);
  const [callStatus, setCallStatus] = useState('off');
  const [peerIds, setPeerIds] = useState([]);
  const [remoteCameraStreams, setRemoteCameraStreams] = useState({});
  const [remoteScreenStreams, setRemoteScreenStreams] = useState({});
  const [activeScreenSharers, setActiveScreenSharers] = useState({});

  const inCallRef = useRef(false);
  const peersRef = useRef(new Map());
  const remoteTrackStoreRef = useRef(new Map()); // peerId -> { cameraTrackId, screenTrackId }

  const micTrackRef = useRef(null);
  const cameraTrackRef = useRef(null);
  const screenStreamRef = useRef(null);
  const screenTrackRef = useRef(null);
  const screenAudioTrackRef = useRef(null);

  const localCameraStream = useMemo(() => {
    const track = cameraTrackRef.current;
    return track ? new MediaStream([track]) : null;
  }, [cameraEnabled]);

  const localScreenStream = useMemo(() => {
    const track = screenTrackRef.current;
    return track ? new MediaStream([track]) : null;
  }, [screenSharing]);

  const refreshStatus = useCallback(() => {
    if (!inCallRef.current) {
      setCallStatus('off');
      return;
    }
    const peers = [...peersRef.current.values()];
    if (peers.length === 0) {
      setCallStatus('connecting');
      return;
    }
    const connected = peers.some((entry) => entry.pc.connectionState === 'connected');
    setCallStatus(connected ? 'connected' : 'connecting');
  }, []);

  const updateMicSenders = useCallback((track) => {
    peersRef.current.forEach((entry) => {
      if (entry.micSender && !track) {
        try { entry.pc.removeTrack(entry.micSender); } catch { /* ignore */ }
        entry.micSender = null;
      } else if (!entry.micSender && track) {
        entry.micSender = entry.pc.addTrack(track, new MediaStream([track]));
      } else if (entry.micSender && track) {
        entry.micSender.replaceTrack(track).catch(() => {});
      }
    });
  }, []);

  const updateCameraSenders = useCallback((track) => {
    peersRef.current.forEach((entry) => {
      if (entry.cameraSender && !track) {
        try { entry.pc.removeTrack(entry.cameraSender); } catch { /* ignore */ }
        entry.cameraSender = null;
      } else if (!entry.cameraSender && track) {
        entry.cameraSender = entry.pc.addTrack(track, new MediaStream([track]));
      } else if (entry.cameraSender && track) {
        entry.cameraSender.replaceTrack(track).catch(() => {});
      }
    });
  }, []);

  const updateScreenVideoSenders = useCallback((track) => {
    peersRef.current.forEach((entry) => {
      if (entry.screenVideoSender && !track) {
        try { entry.pc.removeTrack(entry.screenVideoSender); } catch { /* ignore */ }
        entry.screenVideoSender = null;
      } else if (!entry.screenVideoSender && track) {
        entry.screenVideoSender = entry.pc.addTrack(track, new MediaStream([track]));
      } else if (entry.screenVideoSender && track) {
        entry.screenVideoSender.replaceTrack(track).catch(() => {});
      }
    });
  }, []);

  const updateScreenAudioSenders = useCallback((track) => {
    peersRef.current.forEach((entry) => {
      if (entry.screenAudioSender && !track) {
        try { entry.pc.removeTrack(entry.screenAudioSender); } catch { /* ignore */ }
        entry.screenAudioSender = null;
      } else if (!entry.screenAudioSender && track) {
        entry.screenAudioSender = entry.pc.addTrack(track, new MediaStream([track]));
      } else if (entry.screenAudioSender && track) {
        entry.screenAudioSender.replaceTrack(track).catch(() => {});
      }
    });
  }, []);

  const removePeer = useCallback((peerId) => {
    const entry = peersRef.current.get(peerId);
    if (!entry) return;
    try { entry.pc.close(); } catch { /* ignore */ }
    if (entry.audioEl) {
      entry.audioEl.srcObject = null;
      entry.audioEl.remove();
    }
    peersRef.current.delete(peerId);
    remoteTrackStoreRef.current.delete(peerId);
    setPeerIds((prev) => prev.filter((id) => id !== peerId));
    setRemoteCameraStreams((prev) => {
      const next = { ...prev };
      delete next[peerId];
      return next;
    });
    setRemoteScreenStreams((prev) => {
      const next = { ...prev };
      delete next[peerId];
      return next;
    });
    setActiveScreenSharers((prev) => {
      const next = { ...prev };
      delete next[peerId];
      return next;
    });
    refreshStatus();
  }, [refreshStatus]);

  const getOrCreatePeer = useCallback((peerId) => {
    const existing = peersRef.current.get(peerId);
    if (existing) return existing;

    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    const inboundStream = new MediaStream();

    const audioEl = document.createElement('audio');
    audioEl.autoplay = true;
    audioEl.playsInline = true;
    audioEl.srcObject = inboundStream;
    document.body.appendChild(audioEl);

    const entry = {
      pc,
      audioEl,
      inboundStream,
      micSender: null,
      cameraSender: null,
      screenVideoSender: null,
      screenAudioSender: null,
    };

    pc.onicecandidate = (e) => {
      if (e.candidate) socket.emit('voice-ice', { to: peerId, candidate: e.candidate });
    };

    pc.onnegotiationneeded = async () => {
      try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        socket.emit('voice-offer', { to: peerId, sdp: pc.localDescription });
      } catch {
        // Ignore mid-negotiation races.
      }
    };

    pc.ontrack = (e) => {
      const track = e.track;
      if (track.kind === 'audio') {
        const [stream] = e.streams;
        if (stream) {
          stream.getTracks().forEach((t) => {
            if (!inboundStream.getTracks().some((x) => x.id === t.id)) {
              inboundStream.addTrack(t);
            }
          });
        } else if (!inboundStream.getTracks().some((x) => x.id === track.id)) {
          inboundStream.addTrack(track);
        }
        return;
      }

      if (track.kind === 'video') {
        const info = remoteTrackStoreRef.current.get(peerId) || {};
        const isKnownScreen = info.screenTrackId && track.id === info.screenTrackId;
        const hasCamera = Boolean(info.cameraTrackId);
        const assumeSecondVideoIsScreen = !isKnownScreen && hasCamera && info.cameraTrackId !== track.id;
        const isScreenTrack = Boolean(isKnownScreen || assumeSecondVideoIsScreen);

        remoteTrackStoreRef.current.set(peerId, {
          ...info,
          cameraTrackId: isScreenTrack ? info.cameraTrackId : track.id,
          screenTrackId: isScreenTrack ? (info.screenTrackId || track.id) : info.screenTrackId,
        });

        const targetSetter = isScreenTrack ? setRemoteScreenStreams : setRemoteCameraStreams;
        const stream = new MediaStream([track]);
        targetSetter((prev) => ({ ...prev, [peerId]: stream }));
      }
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed' || pc.connectionState === 'disconnected') {
        removePeer(peerId);
        return;
      }
      refreshStatus();
    };

    peersRef.current.set(peerId, entry);
    setPeerIds((prev) => (prev.includes(peerId) ? prev : [...prev, peerId]));

    if (micTrackRef.current) {
      entry.micSender = pc.addTrack(micTrackRef.current, new MediaStream([micTrackRef.current]));
    }
    const cameraTrack = cameraTrackRef.current;
    if (cameraTrack) {
      entry.cameraSender = pc.addTrack(cameraTrack, new MediaStream([cameraTrack]));
    }
    const screenTrack = screenTrackRef.current;
    if (screenTrack) {
      entry.screenVideoSender = pc.addTrack(screenTrack, new MediaStream([screenTrack]));
    }
    if (screenAudioTrackRef.current) {
      entry.screenAudioSender = pc.addTrack(screenAudioTrackRef.current, new MediaStream([screenAudioTrackRef.current]));
    }

    refreshStatus();
    return entry;
  }, [refreshStatus, removePeer]);

  const stopScreenShare = useCallback(() => {
    if (screenTrackRef.current) {
      try { screenTrackRef.current.stop(); } catch { /* ignore */ }
    }
    if (screenAudioTrackRef.current) {
      try { screenAudioTrackRef.current.stop(); } catch { /* ignore */ }
    }
    if (screenStreamRef.current) {
      screenStreamRef.current.getTracks().forEach((t) => {
        try { t.stop(); } catch { /* ignore */ }
      });
    }

    screenTrackRef.current = null;
    screenAudioTrackRef.current = null;
    screenStreamRef.current = null;
    setScreenSharing(false);
    setScreenAudioShared(false);

    updateScreenAudioSenders(null);
    updateScreenVideoSenders(null);
    socket.emit('screen-share-state', { active: false, trackId: null });
  }, [updateScreenAudioSenders, updateScreenVideoSenders]);

  const startCall = useCallback(() => {
    if (inCallRef.current) return;
    inCallRef.current = true;
    setInCall(true);
    setCallStatus('connecting');
    socket.emit('voice-join');
  }, []);

  const leaveCall = useCallback(() => {
    socket.emit('voice-leave');

    peersRef.current.forEach((entry) => {
      try { entry.pc.close(); } catch { /* ignore */ }
      if (entry.audioEl) {
        entry.audioEl.srcObject = null;
        entry.audioEl.remove();
      }
    });
    peersRef.current.clear();

    if (micTrackRef.current) {
      try { micTrackRef.current.stop(); } catch { /* ignore */ }
      micTrackRef.current = null;
    }
    if (cameraTrackRef.current) {
      try { cameraTrackRef.current.stop(); } catch { /* ignore */ }
      cameraTrackRef.current = null;
    }
    if (screenTrackRef.current || screenAudioTrackRef.current || screenStreamRef.current) {
      stopScreenShare();
    }

    inCallRef.current = false;
    setInCall(false);
    setMicEnabled(false);
    setCameraEnabled(false);
    setScreenSharing(false);
    setScreenAudioShared(false);
    setPeerIds([]);
    setRemoteCameraStreams({});
    setRemoteScreenStreams({});
    setActiveScreenSharers({});
    setCallStatus('off');
  }, [stopScreenShare]);

  const toggleMic = useCallback(async () => {
    if (micTrackRef.current) {
      updateMicSenders(null);
      try { micTrackRef.current.stop(); } catch { /* ignore */ }
      micTrackRef.current = null;
      setMicEnabled(false);
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      const [track] = stream.getAudioTracks();
      if (!track) return;
      micTrackRef.current = track;
      updateMicSenders(track);
      setMicEnabled(true);
    } catch {
      alert('Microphone permission is required to turn on your mic.');
    }
  }, [updateMicSenders]);

  const toggleCamera = useCallback(async () => {
    if (cameraTrackRef.current) {
      const old = cameraTrackRef.current;
      cameraTrackRef.current = null;
      updateCameraSenders(null);
      try { old.stop(); } catch { /* ignore */ }
      setCameraEnabled(false);
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      const [track] = stream.getVideoTracks();
      if (!track) return;
      track.contentHint = 'motion';
      cameraTrackRef.current = track;
      updateCameraSenders(track);
      setCameraEnabled(true);
    } catch {
      alert('Camera permission is required to turn on your camera.');
    }
  }, [updateCameraSenders]);

  const startScreenShare = useCallback(async (withAudio = true) => {
    if (screenTrackRef.current) return;

    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: 30 },
        audio: withAudio
          ? { echoCancellation: false, noiseSuppression: false, suppressLocalAudioPlayback: false }
          : false,
      });

      const [videoTrack] = stream.getVideoTracks();
      if (!videoTrack) {
        stream.getTracks().forEach((t) => {
          try { t.stop(); } catch { /* ignore */ }
        });
        return;
      }

      const [audioTrack] = stream.getAudioTracks();
      videoTrack.contentHint = 'detail';

      screenStreamRef.current = stream;
      screenTrackRef.current = videoTrack;
      screenAudioTrackRef.current = audioTrack || null;

      videoTrack.onended = () => stopScreenShare();

      updateScreenVideoSenders(videoTrack);
      updateScreenAudioSenders(audioTrack || null);
      socket.emit('screen-share-state', { active: true, trackId: videoTrack.id });

      setScreenSharing(true);
      setScreenAudioShared(Boolean(audioTrack));
    } catch {
      // User canceled picker or browser denied screen share.
    }
  }, [stopScreenShare, updateScreenAudioSenders, updateScreenVideoSenders]);

  const toggleScreenShare = useCallback(async () => {
    if (screenTrackRef.current) {
      stopScreenShare();
      return;
    }
    await startScreenShare(true);
  }, [startScreenShare, stopScreenShare]);

  useEffect(() => {
    const onPeers = async ({ peers = [] }) => {
      for (const peerId of peers) {
        const { pc } = getOrCreatePeer(peerId);
        try {
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          socket.emit('voice-offer', { to: peerId, sdp: offer });
        } catch {
          // Ignore races.
        }
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
      } catch {
        // Ignore races.
      }
    };

    const onAnswer = async ({ from, sdp }) => {
      const entry = peersRef.current.get(from);
      if (!entry) return;
      try {
        await entry.pc.setRemoteDescription(new RTCSessionDescription(sdp));
      } catch {
        // Ignore races.
      }
    };

    const onIce = async ({ from, candidate }) => {
      const entry = peersRef.current.get(from);
      if (!entry || !candidate) return;
      try {
        await entry.pc.addIceCandidate(new RTCIceCandidate(candidate));
      } catch {
        // Ignore races.
      }
    };

    const onPeerLeft = ({ id } = {}) => {
      if (id) removePeer(id);
    };

    const onScreenShareState = ({ from, active, trackId } = {}) => {
      if (!from) return;
      const prior = remoteTrackStoreRef.current.get(from) || {};
      remoteTrackStoreRef.current.set(from, {
        ...prior,
        screenTrackId: active ? (trackId || prior.screenTrackId || null) : null,
      });
      setActiveScreenSharers((prev) => ({ ...prev, [from]: !!active }));

      if (!active) {
        setRemoteScreenStreams((prev) => {
          const next = { ...prev };
          delete next[from];
          return next;
        });
      }
    };

    socket.on('voice-peers', onPeers);
    socket.on('voice-offer', onOffer);
    socket.on('voice-answer', onAnswer);
    socket.on('voice-ice', onIce);
    socket.on('voice-peer-left', onPeerLeft);
    socket.on('screen-share-state', onScreenShareState);

    return () => {
      socket.off('voice-peers', onPeers);
      socket.off('voice-offer', onOffer);
      socket.off('voice-answer', onAnswer);
      socket.off('voice-ice', onIce);
      socket.off('voice-peer-left', onPeerLeft);
      socket.off('screen-share-state', onScreenShareState);
    };
  }, [getOrCreatePeer, refreshStatus, removePeer]);

  useEffect(() => () => {
    leaveCall();
  }, [leaveCall]);

  return {
    inCall,
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
  };
}
