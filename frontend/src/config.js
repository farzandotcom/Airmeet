export const API_URL =
  import.meta.env.VITE_API_URL || "http://localhost:5000";

export const ICE_SERVERS = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" }
  // Production: add your TURN server here:
  // { urls: "turn:your-turn-server:3478", username: "...", credential: "..." }
];
