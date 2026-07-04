# 🎬 YouTube Watch Party

Watch YouTube together, perfectly in sync. Up to **six people** can enter the
same room and share synchronized **play, pause, seek, and video changes** across
their devices. The server is the single source of truth for timing, and clients
run drift correction to stay closely aligned.

## Tech stack

- **Frontend:** React + Vite
- **Backend:** Node.js + Express
- **Realtime:** Socket.IO
- **Playback:** YouTube IFrame Player API
- **State:** In-memory rooms (no database)

## Project structure

```
.
├── package.json
├── vite.config.js
├── index.html            # loads the YouTube IFrame API + React app
├── server.js             # Express + Socket.IO, source-of-truth room state
├── src/
│   ├── main.jsx          # React entry
│   ├── App.jsx           # Home <-> Room switch, "Room is full" banner
│   ├── Home.jsx          # create / join room
│   ├── Room.jsx          # player + all sync + drift-correction logic
│   ├── socket.js         # Socket.IO client + clock-offset calculation
│   ├── useYouTubePlayer.js  # IFrame Player API hook
│   ├── utils.js          # video-ID parsing + time formatting
│   └── style.css
└── README.md
```

## Installation

Requires **Node.js 18+** and npm.

```bash
npm install
```

## Run locally (development)

You need **two processes**: the backend (Socket.IO) and the Vite dev server.
Vite proxies `/socket.io` to the backend automatically (see `vite.config.js`).

Open two terminals:

```bash
# Terminal 1 — backend on http://localhost:3001
npm run server
```

```bash
# Terminal 2 — frontend on http://localhost:5173
npm run dev
```

Then open **http://localhost:5173**.

## Run in production mode

Build the frontend and let Express serve the static files:

```bash
npm run build      # outputs to dist/
npm start          # serves dist/ + Socket.IO on http://localhost:3001
```

Then open **http://localhost:3001**.

## Available scripts

| Script            | What it does                                   |
| ----------------- | ---------------------------------------------- |
| `npm run dev`     | Start the Vite dev server (frontend).          |
| `npm run server`  | Start the Express + Socket.IO backend.         |
| `npm run build`   | Build the frontend into `dist/`.               |
| `npm start`       | Start the backend (serves `dist/` in prod).    |

## How to test with two browser windows

1. Start both processes (`npm run server` and `npm run dev`).
2. Open **http://localhost:5173** in a normal window.
3. Paste a YouTube URL or video ID and click **Create room**.
4. Copy the 5-character room code (there's a **Copy** button).
5. Open a **second** window (a private/incognito window works well) at the same
   URL, paste the code, and click **Join room**.
6. Press play/pause/seek in either window — the other follows. Watch the
   **Drift** metric stay near `0.00s`.
7. Open a **third** window and try to join the same code — you'll see
   **"Room is full."**

> Tip: two tabs in the same browser also work, but separate windows make it
> easier to see both players at once.

## How synchronization works

- The **server stores authoritative state** per room:
  `{ videoId, isPlaying, currentTime, lastUpdatedServerTime }`.
- Each client computes a **clock offset** to the server (Socket.IO ping/response)
  so everyone shares a common timeline via `serverNow()`.
- On **play**, the server broadcasts a `startAtServerTime` slightly in the future;
  both clients **seek first, then start** at that exact moment.
- A **drift-correction loop** runs every 2 seconds: if the local player is more
  than **0.3s** off the expected position it **seeks**; small drift nudges the
  **playback rate** briefly instead.
- An `isApplyingRemoteUpdate` flag prevents **feedback loops** so remote-driven
  changes are not rebroadcast.
- **Room lifecycle:** up to 6 users; if a user leaves the others keep the
  room and its state; when everyone leaves the room is deleted from memory.

## Socket events

`createRoom`, `joinRoom`, `leaveRoom`, `roomState`, `play`, `pause`, `seek`,
`changeVideo`, `addToQueue`, `removeFromQueue`, `skipVideo`, `videoEnded`,
`queueUpdate`, `reaction`, `chat`, `system`, `requestRoomState`,
`addPlaylistToQueue`,
`voice-join`, `voice-leave`, `voice-peers`, `voice-offer`, `voice-answer`,
`voice-ice`, `voice-peer-left`,
`syncRequest`/`syncResponse`, `userCount`, `peerLeft`, `roomFull`, `errorMessage`.

## Features

- 🎬 **Synced playback** — play / pause / seek / video change, server-authoritative
  with drift correction.
- 📋 **Shared queue / playlist** — add, remove, auto-advance on end, skip button,
  titles + thumbnails (via YouTube oEmbed, no key).
- 🎵 **Paste a whole playlist** — drop a YouTube playlist URL and every video is
  expanded into the shared queue and played in order (requires the free API key).
- 🙋 **Display names** — pick a name; see "Alex paused / added a video".
- 😀 **Emoji reactions** — floating emoji both people see in real time.
- 💬 **Text chat** — group chat panel (floating popup) with unread badge.
- 🎤 **Live group voice / karaoke** — everyone in the room can talk or sing together
  over a peer-to-peer WebRTC **mesh** (with mute toggle). Signaling runs through
  Socket.IO; audio flows directly between browsers. Best for small groups (up to 6).
- 🔗 **One-click join links & native share** — share `?room=CODE` links; on phones
  the Share button opens the native share sheet.
- 📱 **Mobile-friendly** — sticky video, touch-sized controls, safe-area padding.
- 🌈 **Bright, cute animated pastel background & vibrant theme.**

## Enabling playlist import (optional, free)

Playlist import is proxied through the backend so your API key stays server-side
and is never shipped to the browser. Without a key, everything else works; pasting
a playlist shows a friendly note (you can always paste individual video links).

1. Create a key: Google Cloud Console → enable **YouTube Data API v3** → create an
   API key. (Free tier: 10,000 units/day; a playlist page costs ~1 unit.)
2. Provide it to the server as the `YOUTUBE_API_KEY` environment variable:
   - **Local:** `setx YOUTUBE_API_KEY "your-key"` (new terminal), or set it inline.
   - **Render:** service → **Environment** → add `YOUTUBE_API_KEY` → save (redeploys).

## Limitations

Perfect frame-level synchronization **cannot be guaranteed** because of network
latency and browser/player buffering. However, the server-authoritative timing
model plus continuous drift correction keeps both devices **closely
synchronized** (typically well under a second apart). Autoplay policies may
require a user interaction (a click) before playback starts in some browsers.

**Voice chat across different networks:** live voice uses a peer-to-peer WebRTC
**mesh** (each participant connects to every other) with free public **STUN**
servers, which works for most home networks and small groups. Some strict or
symmetric NATs (common on mobile carriers or corporate Wi-Fi) may block the direct
connection — a **TURN** relay server would be needed for those cases, and one is
**not included** here. Very large groups would also need a media server (SFU);
the mesh is intended for up to ~6 people. Text chat and video sync always work
regardless of network.
