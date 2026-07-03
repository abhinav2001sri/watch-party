// -----------------------------------------------------------------------------
// Socket.IO client singleton + server clock synchronization.
//
// We maintain a running estimate of the offset between the local clock and the
// server clock so that `serverNow()` returns an approximation of Date.now() as
// measured on the server. This lets every client agree on a shared timeline for
// scheduled playback and drift correction.
// -----------------------------------------------------------------------------

import { io } from 'socket.io-client';

// In dev, Vite proxies /socket.io to localhost:3001 (see vite.config.js), so a
// same-origin connection works for both dev and production builds.
export const socket = io('/', {
  autoConnect: true,
  transports: ['websocket', 'polling'],
});

// clockOffset = serverTime - clientTime (ms). serverNow() = Date.now() + clockOffset.
let clockOffset = 0;
let bestRtt = Infinity;

export function serverNow() {
  return Date.now() + clockOffset;
}

export function getClockOffset() {
  return clockOffset;
}

// Perform a single ping/response round to refine the clock offset.
function pingOnce() {
  const clientSentTime = Date.now();
  socket.emit('syncRequest', clientSentTime);
}

socket.on('syncResponse', ({ clientSentTime, serverTime }) => {
  const now = Date.now();
  const rtt = now - clientSentTime;
  // Only accept samples with a better (lower) RTT to reduce jitter — the
  // lowest-latency sample gives the most accurate offset estimate.
  if (rtt < bestRtt) {
    bestRtt = rtt;
    // Assume symmetric latency: server timestamp corresponds to clientSentTime + rtt/2.
    clockOffset = serverTime - (clientSentTime + rtt / 2);
  }
});

// Kick off periodic clock synchronization.
export function startClockSync() {
  // Reset the RTT window periodically so we can adapt to changing conditions.
  const burst = () => {
    bestRtt = Infinity;
    for (let i = 0; i < 5; i++) {
      setTimeout(pingOnce, i * 200);
    }
  };
  socket.on('connect', burst);
  if (socket.connected) burst();
  // Re-sync every 10 seconds.
  setInterval(burst, 10000);
}
