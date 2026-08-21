import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { io } from "socket.io-client";
import { API_URL, ICE_SERVERS } from "./config";

const uid = () => Math.random().toString(36).slice(2, 10);
const roomCode = () => Math.random().toString(36).slice(2, 8).toUpperCase();

function VideoTile({ participant, stream, local, onClick }) {
  const ref = useRef(null);
  useEffect(() => {
    if (ref.current) ref.current.srcObject = stream || null;
  }, [stream]);
  return (
    <div className={`tile ${participant.speaking ? "speaking" : ""}`} onClick={onClick}>
      {stream && participant.camera !== false ? (
        <video ref={ref} autoPlay playsInline muted={local} />
      ) : (
        <div className="avatar">{(participant.name || "?")[0].toUpperCase()}</div>
      )}
      <div className="tile-name">
        {participant.name}{participant.host ? " · Host" : participant.coHost ? " · Co-host" : ""}
        {participant.mic === false && <span title="Muted"> 🔇</span>}
        {participant.hand && <span title="Raised hand"> ✋</span>}
      </div>
      {participant.connection && <div className="connection">● {participant.connection}</div>}
    </div>
  );
}

function App() {
  const [screen, setScreen] = useState("home");
  const [roomId, setRoomId] = useState("");
  const [joinName, setJoinName] = useState("");
  const [meeting, setMeeting] = useState(null);
  const [participants, setParticipants] = useState({});
  const [chat, setChat] = useState([]);
  const [message, setMessage] = useState("");
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [peopleOpen, setPeopleOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [mic, setMic] = useState(true);
  const [camera, setCamera] = useState(true);
  const [hand, setHand] = useState(false);
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [locked, setLocked] = useState(false);
  const [notice, setNotice] = useState("");
  const [permission, setPermission] = useState({ chat: true, screen: true });
  const [activeSpeaker, setActiveSpeaker] = useState(null);
  const [reaction, setReaction] = useState(null);

  const socketRef = useRef(null);
  const localStreamRef = useRef(null);
  const screenStreamRef = useRef(null);
  const peersRef = useRef({});
  const remoteStreamsRef = useRef({});
  const analyserRef = useRef(null);
  const recorderRef = useRef(null);
  const recordedChunksRef = useRef([]);
  const joinedAtRef = useRef(null);
  const fileInputRef = useRef(null);    
  const me = socketRef.current?.id;
  const participantList = useMemo(() => Object.values(participants), [participants]);
  const localParticipant = participants[me];

  const showNotice = useCallback((text) => {
    setNotice(text);
    window.clearTimeout(showNotice.timer);
    showNotice.timer = window.setTimeout(() => setNotice(""), 3500);
  }, []);

  const updateParticipant = useCallback((id, patch) => {
    setParticipants(prev => prev[id] ? { ...prev, [id]: { ...prev[id], ...patch } } : prev);
  }, []);

  const cleanupPeer = useCallback((id) => {
    try { peersRef.current[id]?.close(); } catch {}
    delete peersRef.current[id];
    delete remoteStreamsRef.current[id];
    setParticipants(prev => {
      const copy = { ...prev };
      delete copy[id];
      return copy;
    });
  }, []);

  const createPeer = useCallback((peerId, initiator) => {
  if (peersRef.current[peerId]) return peersRef.current[peerId];

  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  peersRef.current[peerId] = pc;

  const stream = localStreamRef.current;

  if (stream) {
    stream.getTracks().forEach(track => {
      pc.addTrack(track, stream);
    });
  }

  if (screenStreamRef.current) {
    screenStreamRef.current.getVideoTracks().forEach(track => {
      pc.addTrack(track, screenStreamRef.current);
    });
  }

  pc.onicecandidate = e => {
    if (e.candidate) {
      socketRef.current?.emit("ice-candidate", {
        to: peerId,
        candidate: e.candidate
      });
    }
  };

  pc.ontrack = e => {
    const s =
      remoteStreamsRef.current[peerId] ||
      new MediaStream();

    if (!s.getTracks().some(t => t.id === e.track.id)) {
      s.addTrack(e.track);
    }

    remoteStreamsRef.current[peerId] = s;

    setParticipants(prev => ({
      ...prev,
      [peerId]: {
        ...(prev[peerId] || {
          id: peerId,
          name: "Participant"
        }),
        stream: s
      }
    }));
  };

  pc.onconnectionstatechange = () => {
    const state = pc.connectionState;

    updateParticipant(peerId, {
      connection: state === "connected" ? "Good" : state
    });

    if (["failed", "closed", "disconnected"].includes(state)) {
      if (state === "failed") {
        try {
          pc.restartIce();
        } catch {}
      }
    }
  };

  if (initiator) {
    pc.createOffer()
      .then(o => pc.setLocalDescription(o))
      .then(() => {
        socketRef.current?.emit("offer", {
          to: peerId,
          offer: pc.localDescription
        });
      })
      .catch(() => {});
  }

  return pc;
}, [updateParticipant]);
  const replaceVideoTrack = useCallback(async (track) => {
    for (const pc of Object.values(peersRef.current)) {
      const sender = pc.getSenders().find(s => s.track?.kind === "video");
      if (sender && track) await sender.replaceTrack(track);
    }
  }, []);

  const startMedia = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: { facingMode: "user" }
      });
      localStreamRef.current = stream;
      stream.getAudioTracks().forEach(t => t.enabled = true);
      stream.getVideoTracks().forEach(t => t.enabled = true);
      setMic(true); setCamera(true);
    } catch (err) {
      try {
        const audioOnly = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
        localStreamRef.current = audioOnly;
        setCamera(false); setMic(true);
        showNotice("Camera permission was denied; joined with microphone.");
      } catch {
        const silent = new MediaStream();
        localStreamRef.current = silent;
        setCamera(false); setMic(false);
        showNotice("Camera and microphone permissions were denied. You can still join.");
      }
    }
  }, [showNotice]);

  const stopMedia = useCallback(() => {
    localStreamRef.current?.getTracks().forEach(t => t.stop());
    screenStreamRef.current?.getTracks().forEach(t => t.stop());
    localStreamRef.current = null;
    screenStreamRef.current = null;
  }, []);

  const startMeeting = async (id, name) => {
    const cleanId = (id || roomCode()).trim().toUpperCase();
    const cleanName = (name || "Guest").trim().slice(0, 40) || "Guest";
    await startMedia();
    const socket = io(API_URL, { transports: ["websocket"] });
    socketRef.current = socket;
    socket.on("connect", () => {
      socket.emit("join-room", { roomId: cleanId, name: cleanName });
    });
    socket.on("join-error", msg => {
      showNotice(msg);
      stopMedia();
      socket.disconnect();
    });
    socket.on("room-joined", data => {
      setMeeting({ roomId: data.roomId, hostId: data.hostId, name: cleanName });
      setLocked(data.locked);
      setPermission(data.permissions || { chat: true, screen: true });
      setParticipants(data.participants);
      joinedAtRef.current = Date.now();
      setScreen("meeting");
      data.participantIds.forEach(id2 => createPeer(id2, true));
    });
    socket.on("user-joined", ({ participant }) => {
      setParticipants(prev => ({ ...prev, [participant.id]: participant }));
      createPeer(participant.id, false);
    });
    socket.on("offer", async ({ from, offer }) => {
      const pc = createPeer(from, false);
      try {
        await pc.setRemoteDescription(offer);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        socket.emit("answer", { to: from, answer: pc.localDescription });
      } catch {}
    });
    socket.on("answer", async ({ from, answer }) => {
      const pc = peersRef.current[from];
      if (!pc) return;
      try { await pc.setRemoteDescription(answer); } catch {}
    });
    socket.on("ice-candidate", async ({ from, candidate }) => {
      const pc = peersRef.current[from];
      if (!pc) return;
      try { await pc.addIceCandidate(candidate); } catch {}
    });
    socket.on("user-left", ({ id }) => cleanupPeer(id));
    socket.on("participant-updated", ({ id, patch }) => updateParticipant(id, patch));
    socket.on("chat-message", msg => setChat(c => [...c, msg]));
    socket.on("reaction", r => {
      setReaction(r);
      window.setTimeout(() => setReaction(null), 1600);
    });
    socket.on("meeting-state", state => {
  setLocked(state.locked);
  setPermission(state.permissions || { chat: true, screen: true });

  setParticipants(prev => {
    const next = {};

    Object.entries(state.participants || {}).forEach(([id, participant]) => {
      next[id] = {
        ...participant,
        stream:
          prev[id]?.stream ||
          remoteStreamsRef.current[id] ||
          undefined
      };
    });

    return next;
  });
});
    socket.on("removed", () => {
      showNotice("You were removed from the meeting.");
      leaveMeeting(false);
    });
    socket.on("force-mute", () => {
      localStreamRef.current?.getAudioTracks().forEach(t => t.enabled = false);
      setMic(false);
      socket.emit("participant-update", { patch: { mic: false } });
      showNotice("The host muted your microphone.");
    });
    socket.on("disconnect", reason => {
      if (screen === "meeting" && reason !== "io client disconnect") showNotice("Connection interrupted. Reconnecting…");
    });
    socket.on("connect_error", () => showNotice("Could not connect to the meeting server."));
  };

  const createMeeting = () => startMeeting(roomCode(), joinName || "Host");

  const joinMeeting = () => {
    if (!roomId.trim()) return showNotice("Enter a meeting ID.");
    startMeeting(roomId, joinName || "Guest");
  };

  const toggleMic = () => {
    const next = !mic;
    localStreamRef.current?.getAudioTracks().forEach(t => t.enabled = next);
    setMic(next);
    socketRef.current?.emit("participant-update", { patch: { mic: next } });
  };

  const toggleCamera = () => {
    const next = !camera;
    localStreamRef.current?.getVideoTracks().forEach(t => t.enabled = next);
    setCamera(next);
    socketRef.current?.emit("participant-update", { patch: { camera: next } });
  };

  const switchCamera = async () => {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    const devices = await navigator.mediaDevices.enumerateDevices();
    const cams = devices.filter(d => d.kind === "videoinput");
    if (cams.length < 2) return showNotice("Only one camera is available.");
    const current = localStreamRef.current?.getVideoTracks()[0]?.getSettings().deviceId;
    const idx = Math.max(0, cams.findIndex(d => d.deviceId === current));
    const next = cams[(idx + 1) % cams.length];
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: next.deviceId } }, audio: false });
      const track = stream.getVideoTracks()[0];
      const old = localStreamRef.current?.getVideoTracks()[0];
      if (old) localStreamRef.current.removeTrack(old);
      localStreamRef.current?.addTrack(track);
      old?.stop();
      await replaceVideoTrack(track);
      setCamera(true);
      socketRef.current?.emit("participant-update", { patch: { camera: true } });
    } catch { showNotice("Unable to switch camera."); }
  };

  const shareScreen = async () => {
    if (!permission.screen) return showNotice("Screen sharing is disabled by the host.");
    if (screenStreamRef.current) {
      screenStreamRef.current.getTracks().forEach(t => t.stop());
      screenStreamRef.current = null;
      const cam = localStreamRef.current?.getVideoTracks()[0];
      if (cam) await replaceVideoTrack(cam);
      socketRef.current?.emit("participant-update", { patch: { sharing: false } });
      return;
    }
    try {
      const s = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
      screenStreamRef.current = s;
      const track = s.getVideoTracks()[0];
      await replaceVideoTrack(track);
      socketRef.current?.emit("participant-update", { patch: { sharing: true } });
      track.onended = () => shareScreen();
    } catch {}
  };

  const sendChat = e => {
  e?.preventDefault();

  const text = message.trim();

  if (!text || !permission.chat) return;

  socketRef.current?.emit("chat-message", {
    type: "text",
    text
  });

  setMessage("");
};
const emojis = [
  "😀", "😂", "😍", "🥰", "😎",
  "👍", "👏", "❤️", "🔥", "🎉",
  "😮", "😢", "😡", "🙏", "💯",
  "🤣", "😊", "😉", "🤔", "🙌"
];

const addEmoji = emoji => {
  if (!permission.chat) return;

  setMessage(prev => prev + emoji);
  setEmojiOpen(false);
};
const handleChatFile = e => {
  const file = e.target.files?.[0];

  if (!file || !permission.chat) {
    e.target.value = "";
    return;
  }

  // Keep chat files reasonably small for Socket.IO.
  const MAX_FILE_SIZE = 5 * 1024 * 1024;

  if (file.size > MAX_FILE_SIZE) {
    showNotice("File is too large. Maximum size is 5 MB.");
    e.target.value = "";
    return;
  }

  const reader = new FileReader();

  reader.onload = () => {
    socketRef.current?.emit("chat-message", {
      type: "file",
      text: "",
      file: {
        name: file.name,
        size: file.size,
        type: file.type || "application/octet-stream",
        data: reader.result
      }
    });

    e.target.value = "";
  };

  reader.onerror = () => {
    showNotice("Unable to read the file.");
    e.target.value = "";
  };

  reader.readAsDataURL(file);
};
  const sendReaction = emoji => {
    socketRef.current?.emit("reaction", { emoji });
    setReaction({ emoji, from: "you" });
  };

  const toggleHand = () => {
    const next = !hand;
    setHand(next);
    socketRef.current?.emit("participant-update", { patch: { hand: next } });
  };

  const toggleRecording = () => {
    if (recording) {
      recorderRef.current?.stop();
      return;
    }
    const stream = localStreamRef.current;
    if (!stream?.getTracks().length) return showNotice("No media stream available for recording.");
    try {
      const recorder = new MediaRecorder(stream);
      recordedChunksRef.current = [];
      recorder.ondataavailable = e => e.data.size && recordedChunksRef.current.push(e.data);
      recorder.onstop = () => {
        const blob = new Blob(recordedChunksRef.current, { type: recorder.mimeType || "video/webm" });
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = `airmeet-${meeting?.roomId || "meeting"}-${Date.now()}.webm`;
        a.click();
        URL.revokeObjectURL(a.href);
        setRecording(false);
      };
      recorder.start(1000);
      recorderRef.current = recorder;
      setRecording(true);
    } catch { showNotice("Recording is not supported by this browser."); }
  };

  const hostAction = (action, target, value) => {
    socketRef.current?.emit("host-action", { action, target, value });
  };

  const leaveMeeting = useCallback((notify = true) => {
    try { recorderRef.current?.stop(); } catch {}
    Object.keys(peersRef.current).forEach(cleanupPeer);
    socketRef.current?.disconnect();
    stopMedia();
    socketRef.current = null;
    setMeeting(null);
    setParticipants({});
    setChat([]);
    setScreen("home");
    setChatOpen(false);
    setPeopleOpen(false);
    if (notify) showNotice("You left the meeting.");
  }, [cleanupPeer, showNotice, stopMedia]);

  useEffect(() => {
    if (screen !== "meeting") return;
    const timer = window.setInterval(() => {
      if (joinedAtRef.current) setElapsed(Math.floor((Date.now() - joinedAtRef.current) / 1000));
    }, 1000);
    return () => clearInterval(timer);
  }, [screen]);

  useEffect(() => {
    if (!localStreamRef.current?.getAudioTracks()[0]) return;
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return;
    const ctx = new AudioContextClass();
    const source = ctx.createMediaStreamSource(localStreamRef.current);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    source.connect(analyser);
    analyserRef.current = { ctx, analyser };
    const data = new Uint8Array(analyser.frequencyBinCount);
    let raf;
    const loop = () => {
      analyser.getByteFrequencyData(data);
      const avg = data.reduce((a,b) => a+b, 0) / data.length;
      if (avg > 22 && mic && me) {
        setActiveSpeaker(me);
        updateParticipant(me, { speaking: true });
        clearTimeout(loop.timer);
        loop.timer = setTimeout(() => updateParticipant(me, { speaking: false }), 450);
      }
      raf = requestAnimationFrame(loop);
    };
    loop();
    return () => {
      cancelAnimationFrame(raf);
      ctx.close().catch(() => {});
    };
  }, [screen, mic, me, updateParticipant]);

  if (screen === "home") {
    return (
      <div className="home">
        <div className="home-card">
          <div className="brand"><span>✦</span> Airmeet</div>
          <h1>Meet. Talk. Collaborate.</h1>
          <p>Simple, secure browser meetings with video, audio, screen sharing and chat.</p>
          <input value={joinName} onChange={e=>setJoinName(e.target.value)} placeholder="Your name" maxLength={40}/>
          <button className="primary" onClick={createMeeting}>＋ New meeting</button>
          <div className="divider"><span>or</span></div>
          <div className="join-row">
            <input value={roomId} onChange={e=>setRoomId(e.target.value.toUpperCase())} placeholder="Meeting ID" maxLength={20}/>
            <button onClick={joinMeeting}>Join</button>
          </div>
          <div className="home-note">Use Chrome/Edge/Firefox for the best experience.</div>
        </div>
        {notice && <div className="toast">{notice}</div>}
      </div>
    );
  }

  const gridClass = participantList.length <= 1 ? "one" : participantList.length <= 4 ? "four" : participantList.length <= 9 ? "nine" : "many";
  return (
    <div className="app">
      <header className="topbar">
        <div className="brand small"><span>✦</span> Airmeet</div>
        <div className="meeting-info"><b>{meeting?.roomId}</b><span> · {String(Math.floor(elapsed/60)).padStart(2,"0")}:{String(elapsed%60).padStart(2,"0")}</span></div>
        <div className="top-actions">
          {recording && <span className="record-dot">● Recording</span>}
          <button onClick={()=>navigator.clipboard?.writeText(meeting?.roomId).then(()=>showNotice("Meeting ID copied."))}>Copy ID</button>
          <button onClick={()=>setPeopleOpen(v=>!v)}>People ({participantList.length})</button>
        </div>
      </header>

      <main className={`stage ${gridClass}`}>
        {participantList.map(p => (
          <VideoTile key={p.id} participant={p} stream={p.id===me ? localStreamRef.current : p.stream} local={p.id===me} />
        ))}
        {participantList.length === 0 && <div className="empty">Waiting for participants…</div>}
      </main>

      {reaction && <div className="floating-reaction">{reaction.emoji}</div>}

     {chatOpen && (
  <aside className="side-panel">

    <div className="panel-head">
      <b>Chat</b>

      <button
        onClick={() => setChatOpen(false)}
      >
        ×
      </button>
    </div>

    <div className="messages">

      {chat.length === 0 && (
        <div className="muted">
          No messages yet.
        </div>
      )}

      {chat.map((m, i) => (
        <div
          className="msg"
          key={m.id || i}
        >

          <b>{m.name}</b>

          {m.type === "file" && m.file ? (

            <div className="chat-file">

              <span className="chat-file-icon">
                📎
              </span>

              <div className="chat-file-info">

                <strong>
                  {m.file.name}
                </strong>

                <small>
                  {m.file.size
                    ? `${(m.file.size / 1024).toFixed(1)} KB`
                    : "File"}
                </small>

              </div>

              <a
                href={m.file.data}
                download={m.file.name}
                target="_blank"
                rel="noreferrer"
                className="chat-file-download"
              >
                Download
              </a>

            </div>

          ) : (

            <span>
              {m.text}
            </span>

          )}

          <small>
            {new Date(m.time).toLocaleTimeString([], {
              hour: "2-digit",
              minute: "2-digit"
            })}
          </small>

        </div>
      ))}

    </div>

    {emojiOpen && (
      <div className="emoji-picker">

        {emojis.map(emoji => (
          <button
            key={emoji}
            type="button"
            onClick={() => addEmoji(emoji)}
            disabled={!permission.chat}
          >
            {emoji}
          </button>
        ))}

      </div>
    )}

    <form
      className="chat-form"
      onSubmit={sendChat}
    >

      <button
        type="button"
        className="chat-tool"
        onClick={() =>
          setEmojiOpen(prev => !prev)
        }
        disabled={!permission.chat}
        title="Emoji"
      >
        😊
      </button>

      <button
        type="button"
        className="chat-tool"
        onClick={() =>
          fileInputRef.current?.click()
        }
        disabled={!permission.chat}
        title="Attach file"
      >
        📎
      </button>

      <input
        value={message}
        onChange={e =>
          setMessage(e.target.value)
        }
        disabled={!permission.chat}
        placeholder={
          permission.chat
            ? "Type a message…"
            : "Chat disabled"
        }
      />

      <button
        type="submit"
        disabled={
          !permission.chat ||
          !message.trim()
        }
      >
        ➤
      </button>

    </form>

    <input
      ref={fileInputRef}
      type="file"
      style={{ display: "none" }}
      onChange={handleChatFile}
      disabled={!permission.chat}
    />

  </aside>
)}

      {peopleOpen && (
        <aside className="side-panel people">
          <div className="panel-head"><b>Participants</b><button onClick={()=>setPeopleOpen(false)}>×</button></div>
          <div className="participant-list">
            {participantList.map(p => <div className="person" key={p.id}>
              <span className="person-avatar">{p.name[0]?.toUpperCase()}</span>
              <span className="person-name">{p.name}{p.id===me?" (You)":""}{p.hand?" ✋":""}</span>
              <span>{p.mic===false?"🔇":"🎙️"}</span>
              {(meeting?.hostId === me || participants[me]?.coHost) &&
 p.id !== me &&
 meeting?.hostId !== p.id &&
 (!participants[p.id]?.coHost || meeting?.hostId === me) && (
  <div className="person-actions">

    <button onClick={() => hostAction("mute", p.id)}>
      Mute
    </button>

    <button onClick={() => hostAction("remove", p.id)}>
      Remove
    </button>

    {meeting?.hostId === me && (
      <button
        onClick={() =>
          hostAction("cohost", p.id, !p.coHost)
        }
      >
        {p.coHost ? "Uncohost" : "Co-host"}
      </button>
    )}

  </div>
)}
            </div>)}
          </div>
          {meeting?.hostId===me && <div className="host-tools">
            <button onClick={()=>hostAction("lock",null,!locked)}>{locked?"Unlock meeting":"Lock meeting"}</button>
            <button onClick={()=>hostAction("permission",null,{chat:!permission.chat,screen:permission.screen})}>{permission.chat?"Disable chat":"Enable chat"}</button>
            <button onClick={()=>hostAction("permission",null,{chat:permission.chat,screen:!permission.screen})}>{permission.screen?"Disable sharing":"Enable sharing"}</button>
          </div>}
        </aside>
      )}

      {settingsOpen && (
        <div className="settings-pop">
          <b>Meeting settings</b>
          <label>Camera <button onClick={switchCamera}>Switch camera</button></label>
          <label>Audio/video permissions are controlled by your browser.</label>
          <button onClick={()=>setSettingsOpen(false)}>Done</button>
        </div>
      )}

      <footer className="controls">
        <div className="control-group">
          <button className={!mic?"control off":"control"} onClick={toggleMic}><span>{mic?"🎙️":"🔇"}</span><small>{mic?"Mute":"Unmute"}</small></button>
          <button className={!camera?"control off":"control"} onClick={toggleCamera}><span>{camera?"📹":"🚫"}</span><small>{camera?"Stop video":"Start video"}</small></button>
          <button className="control" onClick={shareScreen}><span>🖥️</span><small>{screenStreamRef.current?"Stop share":"Share"}</small></button>
          <button className={hand?"control active":"control"} onClick={toggleHand}><span>✋</span><small>{hand?"Lower hand":"Raise hand"}</small></button>
          <button className="control" onClick={()=>setChatOpen(v=>!v)}><span>💬</span><small>Chat</small></button>
          <button className="control" onClick={()=>setPeopleOpen(v=>!v)}><span>👥</span><small>People</small></button>
          <button className="control" onClick={toggleRecording}><span>{recording?"⏹️":"⏺️"}</span><small>{recording?"Stop rec":"Record"}</small></button>
          <button className="control" onClick={()=>setSettingsOpen(v=>!v)}><span>⚙️</span><small>Settings</small></button>
        </div>
        <div className="reactions">
          {["👍","👏","❤️","😂","🎉"].map(x=><button key={x} onClick={()=>sendReaction(x)}>{x}</button>)}
        </div>
        <button className="leave" onClick={()=>leaveMeeting(true)}>Leave</button>
      </footer>
      {notice && <div className="toast">{notice}</div>}
    </div>
  );
}

export default App;
