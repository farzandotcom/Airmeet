# Airmeet — Zoom-style video meeting app

A simple developer-friendly video meeting application with a separated React frontend and Node/Socket.IO backend.

## Features
- Create/join meeting by room ID
- One-to-one and small group video/audio calling
- Camera/microphone toggles
- Camera device switching
- Screen sharing
- Participant grid with speaking/activity indicators
- In-call chat, emoji reactions, raise hand
- Host/co-host controls
- Host mute, remove participant, lock meeting
- Participant permissions for chat and screen sharing
- Local browser recording using MediaRecorder
- Meeting timer
- Reconnection handling
- Responsive desktop/mobile UI
- Secure random room IDs and server-side room membership checks

> This project uses peer-to-peer WebRTC mesh. It is suitable for small meetings. A production Zoom-scale deployment should use an SFU such as LiveKit, mediasoup, Janus, or Jitsi for large rooms.

## Requirements
- Node.js 20+ recommended
- npm 10+
- Modern Chrome/Edge/Firefox/Safari

## Run

### Terminal 1 — backend
```bash
cd backend
npm install
npm run dev
```

Backend runs on `http://localhost:5000`.

### Terminal 2 — frontend
```bash
cd frontend
npm install
npm run dev
```

Open the Vite URL shown in the terminal, normally `http://localhost:5173`.

## Environment
Frontend optionally accepts:
`VITE_API_URL=http://localhost:5000`

For a deployed app, serve the frontend over HTTPS and run the signaling server behind HTTPS/WSS.

## Important browser note
Camera/microphone/screen capture are browser security features. They require a secure context in production (HTTPS). `localhost` is allowed for development.

## TURN server
For users behind restrictive NAT/firewalls, configure a TURN server by editing `frontend/src/config.js`. STUN alone cannot guarantee connectivity on every network.

## Project structure
- `frontend/` — React/Vite user interface
- `backend/` — Express + Socket.IO signaling/API server
