import express from "express";
import http from "http";
import cors from "cors";
import { Server } from "socket.io";

const app = express();
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());

app.get("/api/health", (_req, res) => res.json({ ok: true, service: "airmeet", time: new Date().toISOString() }));

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: true, credentials: true },
  maxHttpBufferSize: 8 * 1024 * 1024
});

const rooms = new Map();

function safeName(name) {
  return String(name || "Guest").trim().slice(0, 40) || "Guest";
}
function safeRoom(room) {
  return String(room || "").trim().toUpperCase().replace(/[^A-Z0-9_-]/g, "").slice(0, 30);
}
function publicParticipants(room) {
  return Object.fromEntries([...room.participants.entries()].map(([id, p]) => [id, { ...p }]));
}
function broadcastState(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  io.to(roomId).emit("meeting-state", {
    locked: room.locked,
    permissions: room.permissions,
    participants: publicParticipants(room)
  });
}

io.on("connection", socket => {
  socket.on("join-room", ({ roomId, name }) => {
    const id = safeRoom(roomId);
    if (!id) return socket.emit("join-error", "Invalid meeting ID.");

    let room = rooms.get(id);
    if (!room) {
      room = {
        hostId: socket.id,
        locked: false,
        permissions: { chat: true, screen: true },
        participants: new Map()
      };
      rooms.set(id, room);
    }
    if (room.locked && !room.participants.has(socket.id)) {
      return socket.emit("join-error", "This meeting is locked.");
    }

    const participant = {
      id: socket.id,
      name: safeName(name),
      mic: true,
      camera: true,
      hand: false,
      sharing: false,
      mutedByHost: false,
      host: room.hostId === socket.id,
      coHost: false,
      connection: "Connecting"
    };

    const existingIds = [...room.participants.keys()];
    room.participants.set(socket.id, participant);
    socket.data.roomId = id;
    socket.join(id);

    socket.emit("room-joined", {
      roomId: id,
      hostId: room.hostId,
      locked: room.locked,
      permissions: room.permissions,
      participants: publicParticipants(room),
      participantIds: existingIds
    });
    socket.to(id).emit("user-joined", { participant });
    broadcastState(id);
  });

  socket.on("participant-update", ({ patch }) => {
    const room = rooms.get(socket.data.roomId);
    const p = room?.participants.get(socket.id);
    if (!room || !p || !patch || typeof patch !== "object") return;
    const allowed = ["mic", "camera", "hand", "sharing", "connection", "mutedByHost"];
    for (const key of allowed) if (key in patch) p[key] = Boolean(patch[key]) && key !== "connection" ? true : patch[key];
    socket.to(room.id || socket.data.roomId).emit("participant-updated", { id: socket.id, patch });
    broadcastState(socket.data.roomId);
  });

  function relay(event) {
    socket.on(event, ({ to, ...payload }) => {
      if (!to || !io.sockets.sockets.get(to)) return;
      io.to(to).emit(event, { from: socket.id, ...payload });
    });
  }
  relay("offer"); relay("answer"); relay("ice-candidate");

 socket.on("chat-message", ({ type = "text", text = "", file = null }) => {
  const room = rooms.get(socket.data.roomId);
  const p = room?.participants.get(socket.id);

  if (!room || !p || !room.permissions.chat) return;

  // Normal text / emoji message
  if (type === "text") {
    const clean = String(text || "").trim().slice(0, 2000);

    if (!clean) return;

    io.to(socket.data.roomId).emit("chat-message", {
      id: crypto.randomUUID(),
      name: p.name,
      type: "text",
      text: clean,
      time: Date.now()
    });

    return;
  }

  // File message
  if (type === "file" && file) {
    const name = String(file.name || "file").slice(0, 200);
    const mime = String(file.type || "application/octet-stream");
    const size = Number(file.size || 0);
    const data = String(file.data || "");

    // Maximum file size: 5 MB
    if (size <= 0 || size > 5 * 1024 * 1024) return;

    // Only accept data URLs
    if (!data.startsWith("data:")) return;

    io.to(socket.data.roomId).emit("chat-message", {
      id: crypto.randomUUID(),
      name: p.name,
      type: "file",
      text: "",
      file: {
        name,
        type: mime,
        size,
        data
      },
      time: Date.now()
    });
  }
});

  socket.on("reaction", ({ emoji }) => {
    const allowed = ["👍","👏","❤️","😂","🎉","😮","😢","🔥"];
    if (allowed.includes(emoji)) io.to(socket.data.roomId).emit("reaction", { emoji, from: socket.id });
  });
socket.on("host-action", ({ action, target, value }) => {
  const room = rooms.get(socket.data.roomId);
  if (!room) return;

  const actor = room.participants.get(socket.id);
  if (!actor) return;

  const isHost = room.hostId === socket.id;
  const isCoHost = Boolean(actor.coHost);

  // Only host and co-host can perform moderation actions.
  if (!isHost && !isCoHost) return;

  const targetParticipant = target
    ? room.participants.get(target)
    : null;

  const targetSocket = target
    ? io.sockets.sockets.get(target)
    : null;

  // Host/co-host can mute regular participants.
  // A co-host CANNOT mute the host or another co-host.
  if (action === "mute" && targetSocket && targetParticipant) {
    const targetIsHost = room.hostId === target;
    const targetIsCoHost = Boolean(targetParticipant.coHost);

    if (targetIsHost) return;

    if (isCoHost && targetIsCoHost) return;

    targetParticipant.mic = false;
    targetParticipant.mutedByHost = true;
    io.to(socket.data.roomId).emit("participant-updated", {
      id: target,
      patch: { mic: false, mutedByHost: true }
    });
    targetSocket.emit("force-mute");
    return;
  }

  // Host/co-host can unmute a participant they previously muted.
  if (action === "unmute" && targetSocket && targetParticipant) {
    const targetIsHost = room.hostId === target;
    const targetIsCoHost = Boolean(targetParticipant.coHost);

    if (targetIsHost) return;
    if (isCoHost && targetIsCoHost) return;

    targetParticipant.mic = true;
    targetParticipant.mutedByHost = false;
    io.to(socket.data.roomId).emit("participant-updated", {
      id: target,
      patch: { mic: true, mutedByHost: false }
    });
    targetSocket.emit("force-unmute");
    return;
  }

  // Host/co-host can remove regular participants.
  // Co-host cannot remove the host or another co-host.
  if (action === "remove" && targetSocket && targetParticipant) {
    const targetIsHost = room.hostId === target;
    const targetIsCoHost = Boolean(targetParticipant.coHost);

    if (targetIsHost) return;

    if (isCoHost && targetIsCoHost) return;

    targetSocket.emit("removed");
    setTimeout(() => targetSocket.disconnect(true), 50);
    return;
  }

  // Only the original host can lock the meeting.
  if (action === "lock") {
    if (!isHost) return;

    room.locked = Boolean(value);
    return broadcastState(socket.data.roomId);
  }

  // Only the original host can assign/remove co-host.
  if (action === "cohost") {
    if (!isHost) return;
    if (!target || !room.participants.has(target)) return;

    room.participants.get(target).coHost = Boolean(value);
    return broadcastState(socket.data.roomId);
  }

  // Only the original host can change global meeting permissions.
  if (action === "permission") {
    if (!isHost) return;
    if (!value || typeof value !== "object") return;

    room.permissions = {
      chat: Boolean(value.chat),
      screen: Boolean(value.screen)
    };

    return broadcastState(socket.data.roomId);
  }
});

  socket.on("disconnect", () => {
    const roomId = socket.data.roomId;
    const room = rooms.get(roomId);
    if (!room) return;
    room.participants.delete(socket.id);
    socket.to(roomId).emit("user-left", { id: socket.id });

    if (room.hostId === socket.id) {
      const next = room.participants.keys().next().value;
      if (next) {
        room.hostId = next;
        room.participants.get(next).host = true;
        io.to(roomId).emit("meeting-state", {
          locked: room.locked,
          permissions: room.permissions,
          participants: publicParticipants(room),
          hostId: next
        });
      }
    }
    if (room.participants.size === 0) rooms.delete(roomId);
    else broadcastState(roomId);
  });
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, "0.0.0.0", () => {
  console.log(`Airmeet backend running on port ${PORT}`);
});