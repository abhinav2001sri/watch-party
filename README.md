# 🎬 YouTube Watch Party

Watch YouTube together, perfectly in sync. Exactly **two people** can enter the
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
- **Room lifecycle:** max 2 users; if the first user leaves the second keeps the
  room and its state; when everyone leaves the room is deleted from memory.

## Socket events

`createRoom`, `joinRoom`, `leaveRoom`, `roomState`, `play`, `pause`, `seek`,
`changeVideo`, `requestRoomState`, `syncRequest`/`syncResponse`, `userCount`,
`peerLeft`, `roomFull`, `errorMessage`.

## Limitations

Perfect frame-level synchronization **cannot be guaranteed** because of network
latency and browser/player buffering. However, the server-authoritative timing
model plus continuous drift correction keeps both devices **closely
synchronized** (typically well under a second apart). Autoplay policies may
require a user interaction (a click) before playback starts in some browsers.
