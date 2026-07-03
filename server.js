// -----------------------------------------------------------------------------
// YouTube Watch Party - Backend server
//
// Express + Socket.IO server that acts as the *single source of truth* for room
// playback state. Rooms are kept in memory only (no database). A maximum of two
// users are allowed per room.
//
// Timing model:
//   Every room stores { videoId, isPlaying, currentTime, lastUpdatedServerTime }.
//   `currentTime` is the video position (seconds) captured at `lastUpdatedServerTime`
//   (a server Date.now() millisecond value). Given those two numbers a client can
//   always reconstruct the "expected" video time:
//
//       expected = currentTime + (isPlaying ? (serverNow - lastUpdatedServerTime)/1000 : 0)
//
//   Clients calculate a clock offset against the server (see `syncRequest`/`syncResponse`)
//   so they can translate their own local clock into server time and compensate for
//   network latency.
// -----------------------------------------------------------------------------

import express from 'express';
import http from 'http';
import cors from 'cors';
import { Server } from 'socket.io';

const app = express();
app.use(cors());

// Serve the production build if it exists (npm run build -> dist/).
app.use(express.static('dist'));

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
});

const PORT = process.env.PORT || 3001;

// In-memory room store. Shape:
// rooms[roomCode] = {
//   videoId: string | null,
//   isPlaying: boolean,
//   currentTime: number,              // video position in seconds
//   lastUpdatedServerTime: number,    // Date.now() when currentTime was captured
//   users: Set<socketId>
// }
const rooms = {};

// Generate a short, human friendly room code (avoids ambiguous chars).
function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = '';
    for (let i = 0; i < 5; i++) {
      code += chars[Math.floor(Math.random() * chars.length)];
    }
  } while (rooms[code]); // Guarantee uniqueness.
  return code;
}

// Compute the room's authoritative "expected" video time for *right now*.
function computeExpectedTime(room) {
  if (!room) return 0;
  if (!room.isPlaying) return room.currentTime;
  const elapsed = (Date.now() - room.lastUpdatedServerTime) / 1000;
  return room.currentTime + elapsed;
}

// Build the payload describing the full room state for clients.
function roomStatePayload(room) {
  return {
    videoId: room.videoId,
    isPlaying: room.isPlaying,
    currentTime: computeExpectedTime(room),
    lastUpdatedServerTime: Date.now(),
    userCount: room.users.size,
    queue: room.queue || [],
  };
}

// Short unique id for queue items.
function randomId() {
  return Math.random().toString(36).slice(2, 10);
}

// Fetch a video's title + thumbnail using YouTube's free public oEmbed endpoint
// (no API key required). Falls back to sensible defaults on any failure.
async function fetchVideoMeta(videoId) {
  const thumbnail = `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`;
  try {
    const res = await fetch(
      `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`
    );
    if (!res.ok) return { title: videoId, thumbnail };
    const data = await res.json();
    return { title: data.title || videoId, thumbnail: data.thumbnail_url || thumbnail };
  } catch {
    return { title: videoId, thumbnail };
  }
}

// Advance to the next queued video (if any) and broadcast the change. The next
// video autoplays so the session flows continuously.
function advanceQueue(room, code) {
  const next = (room.queue || []).shift();
  if (!next) return false;
  room.videoId = next.videoId;
  room.isPlaying = true;
  room.currentTime = 0;
  room.lastUpdatedServerTime = Date.now();
  io.to(code).emit('changeVideo', { videoId: next.videoId, autoplay: true, serverTime: Date.now() });
  io.to(code).emit('queueUpdate', room.queue);
  return true;
}

io.on('connection', (socket) => {
  // Each socket may belong to at most one room; we track it for cleanup.
  socket.data.roomCode = null;

  // ---------------------------------------------------------------------------
  // Clock sync: client sends its local timestamp, server replies with both the
  // echoed client time and the server time so the client can compute latency
  // and clock offset.
  // ---------------------------------------------------------------------------
  socket.on('syncRequest', (clientSentTime) => {
    socket.emit('syncResponse', {
      clientSentTime,
      serverTime: Date.now(),
    });
  });

  // ---------------------------------------------------------------------------
  // createRoom -> creates a fresh room and joins the creator to it.
  // ---------------------------------------------------------------------------
  socket.on('createRoom', ({ videoId } = {}, ack) => {
    const roomCode = generateRoomCode();
    rooms[roomCode] = {
      videoId: videoId || null,
      isPlaying: false,
      currentTime: 0,
      lastUpdatedServerTime: Date.now(),
      users: new Set(),
      queue: [], // Shared upcoming-videos playlist.
    };

    joinRoomInternal(socket, roomCode, ack);
  });

  // ---------------------------------------------------------------------------
  // joinRoom -> joins an existing room (enforces the 2-user maximum).
  // ---------------------------------------------------------------------------
  socket.on('joinRoom', ({ roomCode } = {}, ack) => {
    roomCode = (roomCode || '').toUpperCase().trim();
    const room = rooms[roomCode];

    if (!room) {
      const msg = 'Room not found';
      socket.emit('errorMessage', msg);
      if (typeof ack === 'function') ack({ ok: false, error: msg });
      return;
    }

    if (room.users.size >= 2 && !room.users.has(socket.id)) {
      socket.emit('roomFull');
      if (typeof ack === 'function') ack({ ok: false, error: 'Room is full' });
      return;
    }

    joinRoomInternal(socket, roomCode, ack);
  });

  // Shared join logic used by createRoom + joinRoom.
  function joinRoomInternal(socket, roomCode, ack) {
    const room = rooms[roomCode];
    socket.join(roomCode);
    socket.data.roomCode = roomCode;
    room.users.add(socket.id);

    // Send the joining client the current authoritative room state immediately
    // so it can sync to whatever is already playing.
    const payload = roomStatePayload(room);
    socket.emit('roomState', payload);

    // Notify everyone (including the joiner) of the updated user count.
    io.to(roomCode).emit('userCount', room.users.size);

    if (typeof ack === 'function') {
      ack({ ok: true, roomCode, state: payload });
    }
  }

  // ---------------------------------------------------------------------------
  // Playback events. The server updates its authoritative state, stamps it with
  // the server time, then broadcasts to the *other* client(s) in the room.
  // A `startAtServerTime` slightly in the future is included for play events so
  // both clients can schedule playback at the same wall-clock moment.
  // ---------------------------------------------------------------------------

  socket.on('play', ({ currentTime } = {}) => {
    const room = getSocketRoom(socket);
    if (!room) return;

    room.isPlaying = true;
    room.currentTime = typeof currentTime === 'number' ? currentTime : room.currentTime;
    room.lastUpdatedServerTime = Date.now();

    // Schedule the play ~250ms in the future to give both clients time to seek.
    const startAtServerTime = Date.now() + 250;

    socket.to(room.__code).emit('play', {
      currentTime: room.currentTime,
      startAtServerTime,
      serverTime: Date.now(),
    });
  });

  socket.on('pause', ({ currentTime } = {}) => {
    const room = getSocketRoom(socket);
    if (!room) return;

    room.isPlaying = false;
    room.currentTime = typeof currentTime === 'number' ? currentTime : room.currentTime;
    room.lastUpdatedServerTime = Date.now();

    socket.to(room.__code).emit('pause', {
      currentTime: room.currentTime,
      serverTime: Date.now(),
    });
  });

  socket.on('seek', ({ currentTime } = {}) => {
    const room = getSocketRoom(socket);
    if (!room) return;

    room.currentTime = typeof currentTime === 'number' ? currentTime : room.currentTime;
    room.lastUpdatedServerTime = Date.now();

    socket.to(room.__code).emit('seek', {
      currentTime: room.currentTime,
      isPlaying: room.isPlaying,
      serverTime: Date.now(),
    });
  });

  socket.on('changeVideo', ({ videoId } = {}) => {
    const room = getSocketRoom(socket);
    if (!room || !videoId) return;

    room.videoId = videoId;
    room.isPlaying = false;
    room.currentTime = 0;
    room.lastUpdatedServerTime = Date.now();

    // Broadcast to everyone in the room (including sender) so all reset cleanly.
    // autoplay:false -> the video is cued (loaded, paused) so both start in sync.
    io.to(room.__code).emit('changeVideo', {
      videoId,
      autoplay: false,
      serverTime: Date.now(),
    });
  });

  // A client explicitly requesting the latest authoritative state ("Sync Now").
  socket.on('requestRoomState', () => {
    const room = getSocketRoom(socket);
    if (!room) return;
    socket.emit('roomState', roomStatePayload(room));
  });

  // ---------------------------------------------------------------------------
  // Video queue / playlist events.
  // ---------------------------------------------------------------------------

  // Add a video to the shared queue. If nothing is currently loaded, the video
  // becomes the current (cued) video instead of being queued.
  socket.on('addToQueue', async ({ videoId } = {}) => {
    const room = getSocketRoom(socket);
    if (!room || !videoId) return;

    if (!room.videoId) {
      room.videoId = videoId;
      room.isPlaying = false;
      room.currentTime = 0;
      room.lastUpdatedServerTime = Date.now();
      io.to(room.__code).emit('changeVideo', { videoId, autoplay: false, serverTime: Date.now() });
      return;
    }

    const meta = await fetchVideoMeta(videoId);
    // Re-resolve the room in case things changed during the await.
    const code = socket.data.roomCode;
    const liveRoom = rooms[code];
    if (!liveRoom) return;
    liveRoom.queue.push({ id: randomId(), videoId, title: meta.title, thumbnail: meta.thumbnail });
    io.to(code).emit('queueUpdate', liveRoom.queue);
  });

  // Remove a specific item from the queue.
  socket.on('removeFromQueue', ({ id } = {}) => {
    const room = getSocketRoom(socket);
    if (!room) return;
    room.queue = (room.queue || []).filter((item) => item.id !== id);
    io.to(room.__code).emit('queueUpdate', room.queue);
  });

  // Skip to the next video in the queue immediately ("Next" button).
  socket.on('skipVideo', () => {
    const room = getSocketRoom(socket);
    if (!room) return;
    advanceQueue(room, room.__code);
  });

  // A client reports the current video finished; advance to the next queued one.
  // Guarded by videoId so both clients ending simultaneously only advance once.
  socket.on('videoEnded', ({ videoId } = {}) => {
    const room = getSocketRoom(socket);
    if (!room) return;
    if (room.videoId && room.videoId === videoId) {
      advanceQueue(room, room.__code);
    }
  });

  // ---------------------------------------------------------------------------
  // leaveRoom / disconnect handling + room cleanup.
  // ---------------------------------------------------------------------------
  socket.on('leaveRoom', () => handleLeave(socket));
  socket.on('disconnect', () => handleLeave(socket));

  function handleLeave(socket) {
    const roomCode = socket.data.roomCode;
    if (!roomCode) return;
    const room = rooms[roomCode];
    if (!room) return;

    room.users.delete(socket.id);
    socket.leave(roomCode);
    socket.data.roomCode = null;

    if (room.users.size === 0) {
      // All users left -> delete the room from memory.
      delete rooms[roomCode];
    } else {
      // If the first user leaves, the remaining user keeps the room + state.
      io.to(roomCode).emit('userCount', room.users.size);
      io.to(roomCode).emit('peerLeft');
    }
  }

  // Helper: resolve the room object for a socket, attaching its code for convenience.
  function getSocketRoom(socket) {
    const roomCode = socket.data.roomCode;
    if (!roomCode) return null;
    const room = rooms[roomCode];
    if (!room) return null;
    room.__code = roomCode;
    return room;
  }
});

server.listen(PORT, () => {
  console.log(`\n  YouTube Watch Party server running on http://localhost:${PORT}\n`);
});
