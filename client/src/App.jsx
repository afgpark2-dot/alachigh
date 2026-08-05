import { useState, useEffect, useRef, useCallback } from 'react';
import { io } from 'socket.io-client';
import {
  Send, Phone, Video, PhoneOff, Mic, MicOff, VideoOff,
  Plus, MessageCircle, Paperclip, Search, X, Reply,
  Smile, Trash2, Edit3, Hash, Users
} from 'lucide-react';

const SOCKET_URL = import.meta.env.VITE_SOCKET_URL || '';
const EMOJIS = ['👍', '❤️', '😂', '😮', '😢', '🔥', '👏', '🎉'];

export default function App() {
  const [socket, setSocket] = useState(null);
  const [user, setUser] = useState(null);
  const [username, setUsername] = useState('');
  const [rooms, setRooms] = useState([]);
  const [currentRoom, setCurrentRoom] = useState(null);
  const [messages, setMessages] = useState([]);
  const [members, setMembers] = useState([]);
  const [onlineUsers, setOnlineUsers] = useState([]);
  const [input, setInput] = useState('');
  const [typingUsers, setTypingUsers] = useState([]);
  const [newRoomName, setNewRoomName] = useState('');
  const [replyTo, setReplyTo] = useState(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [showSearch, setShowSearch] = useState(false);
  const [showEmoji, setShowEmoji] = useState(false);

  // Call state
  const [inCall, setInCall] = useState(false);
  const [callType, setCallType] = useState(null);
  const [incomingCall, setIncomingCall] = useState(null);
  const [localStream, setLocalStream] = useState(null);
  const [remoteStreams, setRemoteStreams] = useState({});
  const [muted, setMuted] = useState(false);
  const [videoOff, setVideoOff] = useState(false);

  const peerConnections = useRef({});
  const localVideoRef = useRef(null);
  const messagesEndRef = useRef(null);
  const typingTimeout = useRef(null);
  const fileInputRef = useRef(null);

  useEffect(() => {
    const s = io(SOCKET_URL || undefined, { transports: ['websocket', 'polling'] });
    setSocket(s);
    s.on('connect', () => console.log('متصل شد', s.id));
    return () => s.disconnect();
  }, []);

  useEffect(() => {
    if (!socket) return;

    socket.on('joined', ({ user: u, rooms: r }) => {
      setUser(u);
      setRooms(r);
    });

    socket.on('room-joined', (data) => {
      setCurrentRoom({
        id: data.roomId,
        name: data.name,
        type: data.type,
        description: data.description
      });
      setMessages(data.messages || []);
      setMembers(data.members || []);
      setReplyTo(null);
      setShowSearch(false);
      setSearchQuery('');
    });

    socket.on('message', (msg) => {
      setMessages((prev) => [...prev, msg]);
    });

    socket.on('message-edited', ({ id, text, edited }) => {
      setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, text, edited } : m)));
    });

    socket.on('message-deleted', ({ id }) => {
      setMessages((prev) =>
        prev.map((m) => (m.id === id ? { ...m, deleted: 1, text: 'این پیام حذف شد' } : m))
      );
    });

    socket.on('reaction-updated', ({ id, reactions }) => {
      setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, reactions } : m)));
    });

    socket.on('typing', ({ userId, username: uname, isTyping }) => {
      setTypingUsers((prev) => {
        if (isTyping) {
          if (prev.find((t) => t.userId === userId)) return prev;
          return [...prev, { userId, username: uname }];
        }
        return prev.filter((t) => t.userId !== userId);
      });
    });

    socket.on('user-list', (list) => setOnlineUsers(list));
    socket.on('room-created', (room) => setRooms((prev) => [...prev, room]));

    socket.on('member-joined', ({ user: u }) => {
      setMembers((prev) => {
        if (prev.find((m) => m.id === u.id)) return prev;
        return [...prev, u];
      });
    });

    socket.on('search-results', (results) => {
      setMessages(results);
    });

    socket.on('error', ({ message }) => alert(message));

    // WebRTC
    socket.on('call-offer', async ({ from, socketId, username: uname, offer, callType: ct }) => {
      setIncomingCall({ from, socketId, username: uname, offer, callType: ct });
    });

    socket.on('call-answer', async ({ from, answer }) => {
      const pc = peerConnections.current[from];
      if (pc) await pc.setRemoteDescription(new RTCSessionDescription(answer));
    });

    socket.on('ice-candidate', async ({ from, candidate }) => {
      const pc = peerConnections.current[from];
      if (pc && candidate) {
        try { await pc.addIceCandidate(new RTCIceCandidate(candidate)); } catch {}
      }
    });

    socket.on('call-end', ({ from }) => {
      endPeerConnection(from);
      if (Object.keys(peerConnections.current).length === 0) cleanupCall();
    });

    socket.on('call-reject', () => cleanupCall());

    return () => {
      [
        'joined', 'room-joined', 'message', 'message-edited', 'message-deleted',
        'reaction-updated', 'typing', 'user-list', 'room-created', 'member-joined',
        'search-results', 'error', 'call-offer', 'call-answer', 'ice-candidate',
        'call-end', 'call-reject'
      ].forEach((e) => socket.off(e));
    };
  }, [socket]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  useEffect(() => {
    if (localVideoRef.current && localStream) {
      localVideoRef.current.srcObject = localStream;
    }
  }, [localStream, inCall]);

  const handleLogin = (e) => {
    e.preventDefault();
    if (!username.trim() || !socket) return;
    socket.emit('join', { username: username.trim() });
  };

  const selectRoom = (roomId) => {
    if (!socket || currentRoom?.id === roomId) return;
    socket.emit('join-room', roomId);
  };

  const createRoom = (e) => {
    e.preventDefault();
    if (!newRoomName.trim() || !socket) return;
    socket.emit('create-room', { name: newRoomName.trim(), type: 'group' });
    setNewRoomName('');
  };

  const sendMessage = (e) => {
    e?.preventDefault();
    if (!input.trim() || !socket || !currentRoom) return;
    socket.emit('message', {
      roomId: currentRoom.id,
      text: input.trim(),
      type: 'text',
      replyTo: replyTo?.id || null
    });
    setInput('');
    setReplyTo(null);
    setShowEmoji(false);
    socket.emit('typing', { roomId: currentRoom.id, isTyping: false });
  };

  const handleInputChange = (e) => {
    setInput(e.target.value);
    if (!socket || !currentRoom) return;
    socket.emit('typing', { roomId: currentRoom.id, isTyping: true });
    clearTimeout(typingTimeout.current);
    typingTimeout.current = setTimeout(() => {
      socket.emit('typing', { roomId: currentRoom.id, isTyping: false });
    }, 1500);
  };

  const handleFile = async (e) => {
    const file = e.target.files?.[0];
    if (!file || !socket || !currentRoom) return;
    const form = new FormData();
    form.append('file', file);
    try {
      const res = await fetch('/api/upload', { method: 'POST', body: form });
      const data = await res.json();
      if (data.url) {
        let type = 'file';
        if (file.type.startsWith('image/')) type = 'image';
        else if (file.type.startsWith('video/')) type = 'video';
        else if (file.type.startsWith('audio/')) type = 'audio';
        socket.emit('message', {
          roomId: currentRoom.id,
          text: file.name,
          type,
          fileUrl: data.url,
          fileName: data.name,
          fileSize: data.size,
          replyTo: replyTo?.id || null
        });
        setReplyTo(null);
      }
    } catch (err) {
      alert('خطا در آپلود فایل');
    }
    e.target.value = '';
  };

  const react = (messageId, emoji) => {
    socket?.emit('react', { messageId, emoji });
  };

  const deleteMsg = (messageId) => {
    if (confirm('پیام حذف شود؟')) socket?.emit('delete-message', { messageId });
  };

  const doSearch = () => {
    if (!searchQuery.trim() || !currentRoom) return;
    socket?.emit('search', { roomId: currentRoom.id, query: searchQuery.trim() });
  };

  // WebRTC
  const createPeerConnection = useCallback((peerId) => {
    const pc = new RTCPeerConnection({
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' }
      ]
    });
    pc.onicecandidate = (ev) => {
      if (ev.candidate && socket) {
        socket.emit('ice-candidate', { to: peerId, candidate: ev.candidate });
      }
    };
    pc.ontrack = (ev) => {
      setRemoteStreams((prev) => ({ ...prev, [peerId]: ev.streams[0] }));
    };
    pc.onconnectionstatechange = () => {
      if (['failed', 'closed', 'disconnected'].includes(pc.connectionState)) {
        endPeerConnection(peerId);
      }
    };
    peerConnections.current[peerId] = pc;
    return pc;
  }, [socket]);

  const endPeerConnection = (peerId) => {
    const pc = peerConnections.current[peerId];
    if (pc) { pc.close(); delete peerConnections.current[peerId]; }
    setRemoteStreams((prev) => {
      const n = { ...prev };
      delete n[peerId];
      return n;
    });
  };

  const cleanupCall = () => {
    Object.keys(peerConnections.current).forEach(endPeerConnection);
    if (localStream) {
      localStream.getTracks().forEach((t) => t.stop());
      setLocalStream(null);
    }
    setInCall(false);
    setCallType(null);
    setIncomingCall(null);
    setMuted(false);
    setVideoOff(false);
  };

  const startCall = async (type) => {
    if (!socket || !currentRoom || inCall) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: type === 'video'
      });
      setLocalStream(stream);
      setCallType(type);
      setInCall(true);
      const others = members.filter((m) => m.id !== user?.id);
      for (const member of others) {
        const pc = createPeerConnection(member.id);
        stream.getTracks().forEach((t) => pc.addTrack(t, stream));
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        socket.emit('call-offer', {
          roomId: currentRoom.id,
          offer,
          callType: type,
          to: member.id
        });
      }
    } catch {
      alert('دسترسی به میکروفون/دوربین ممکن نیست');
    }
  };

  const acceptCall = async () => {
    if (!incomingCall || !socket) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: incomingCall.callType === 'video'
      });
      setLocalStream(stream);
      setCallType(incomingCall.callType);
      setInCall(true);
      const pc = createPeerConnection(incomingCall.from);
      stream.getTracks().forEach((t) => pc.addTrack(t, stream));
      await pc.setRemoteDescription(new RTCSessionDescription(incomingCall.offer));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      socket.emit('call-answer', { to: incomingCall.from, answer });
      setIncomingCall(null);
    } catch {
      rejectCall();
    }
  };

  const rejectCall = () => {
    if (incomingCall && socket) socket.emit('call-reject', { to: incomingCall.from });
    setIncomingCall(null);
  };

  const endCall = () => {
    if (socket && currentRoom) socket.emit('call-end', { roomId: currentRoom.id });
    cleanupCall();
  };

  const toggleMute = () => {
    if (localStream) {
      localStream.getAudioTracks().forEach((t) => { t.enabled = muted; });
      setMuted(!muted);
    }
  };

  const toggleVideo = () => {
    if (localStream) {
      localStream.getVideoTracks().forEach((t) => { t.enabled = videoOff; });
      setVideoOff(!videoOff);
    }
  };

  const formatSize = (bytes) => {
    if (!bytes) return '';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / 1048576).toFixed(1) + ' MB';
  };

  const findReply = (id) => messages.find((m) => m.id === id);

  // ========== RENDER ==========
  if (!user) {
    return (
      <div className="login-screen">
        <form className="login-card" onSubmit={handleLogin}>
          <h1>آلاچیق</h1>
          <p>پیام‌رسان ایرانی با تماس صوتی و تصویری</p>
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="نام خود را وارد کنید"
            autoFocus
            maxLength={32}
          />
          <button type="submit" disabled={!username.trim()}>ورود</button>
        </form>
      </div>
    );
  }

  return (
    <div className="app">
      {/* Sidebar */}
      <aside className="sidebar">
        <div className="sidebar-header">
          <h2>چت‌ها</h2>
          <div className="user-badge">
            <div className="avatar sm">{user.username[0]}</div>
            <span>{user.username}</span>
          </div>
        </div>

        <div className="room-list">
          {rooms.map((room) => (
            <div
              key={room.id}
              className={`room-item ${currentRoom?.id === room.id ? 'active' : ''}`}
              onClick={() => selectRoom(room.id)}
            >
              <div className="avatar">
                {room.type === 'channel' ? <Hash size={18} /> : room.name[0]}
              </div>
              <div className="info">
                <div className="name">
                  {room.name}
                  {room.type === 'channel' && <span className="badge" style={{ marginRight: 6 }}>کانال</span>}
                </div>
                <div className="meta">{room.member_count || 0} عضو</div>
              </div>
            </div>
          ))}
        </div>

        <form className="create-room" onSubmit={createRoom}>
          <input
            value={newRoomName}
            onChange={(e) => setNewRoomName(e.target.value)}
            placeholder="نام گروه جدید..."
            maxLength={40}
          />
          <button type="submit" title="ساخت گروه"><Plus size={18} /></button>
        </form>
      </aside>

      {/* Main */}
      <main className="chat-area">
        {currentRoom ? (
          <>
            <header className="chat-header">
              <div>
                <div className="title">
                  {currentRoom.type === 'channel' && <Hash size={16} style={{ verticalAlign: -2, marginLeft: 4 }} />}
                  {currentRoom.name}
                </div>
                <div className="subtitle">
                  {members.length} عضو
                  {typingUsers.length > 0 &&
                    ` · ${typingUsers.map((t) => t.username).join('، ')} در حال نوشتن...`}
                </div>
              </div>
              <div className="header-actions">
                <button className="icon-btn" title="جستجو" onClick={() => setShowSearch(!showSearch)}>
                  <Search size={18} />
                </button>
                <button className="icon-btn" title="تماس صوتی" onClick={() => startCall('audio')} disabled={inCall}>
                  <Phone size={18} />
                </button>
                <button className="icon-btn" title="تماس تصویری" onClick={() => startCall('video')} disabled={inCall}>
                  <Video size={18} />
                </button>
              </div>
            </header>

            {showSearch && (
              <div className="search-bar">
                <input
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="جستجو در پیام‌ها..."
                  onKeyDown={(e) => e.key === 'Enter' && doSearch()}
                  autoFocus
                />
                <button className="icon-btn" onClick={doSearch}><Search size={16} /></button>
                <button className="icon-btn" onClick={() => { setShowSearch(false); selectRoom(currentRoom.id); }}>
                  <X size={16} />
                </button>
              </div>
            )}

            <div className="messages">
              {messages.map((msg) => {
                const isOwn = msg.user_id === user.id || msg.userId === user.id;
                const replyMsg = msg.reply_to ? findReply(msg.reply_to) : null;
                return (
                  <div key={msg.id} className={`message ${isOwn ? 'own' : ''}`}>
                    {!isOwn && <div className="avatar sm">{(msg.username || '?')[0]}</div>}
                    <div className="message-bubble">
                      <div className="message-meta">
                        <span className="author">{msg.username}</span>
                        <span className="time">
                          {new Date(msg.timestamp).toLocaleTimeString('fa-IR', { hour: '2-digit', minute: '2-digit' })}
                          {msg.edited ? ' (ویرایش‌شده)' : ''}
                        </span>
                      </div>

                      {replyMsg && (
                        <div className="reply-preview">
                          <span className="reply-author">{replyMsg.username}</span>
                          <div>{(replyMsg.text || '').slice(0, 60)}</div>
                        </div>
                      )}

                      {msg.deleted ? (
                        <div className="message-text deleted">{msg.text}</div>
                      ) : (
                        <>
                          {msg.type === 'image' && msg.file_url && (
                            <div className="file-attachment">
                              <img src={msg.file_url} alt={msg.file_name} loading="lazy" />
                            </div>
                          )}
                          {msg.type === 'video' && msg.file_url && (
                            <div className="file-attachment">
                              <video src={msg.file_url} controls style={{ maxWidth: 260 }} />
                            </div>
                          )}
                          {(msg.type === 'file' || msg.type === 'audio') && msg.file_url && (
                            <a className="file-attachment" href={msg.file_url} target="_blank" rel="noreferrer">
                              <Paperclip size={18} />
                              <div className="file-info">
                                <div>{msg.file_name || msg.text}</div>
                                <div className="size">{formatSize(msg.file_size)}</div>
                              </div>
                            </a>
                          )}
                          {msg.type === 'text' && <div className="message-text">{msg.text}</div>}
                          {msg.type !== 'text' && msg.text && msg.type !== 'image' && (
                            <div className="message-text" style={{ marginTop: 4 }}>{msg.text}</div>
                          )}
                        </>
                      )}

                      {msg.reactions && Object.keys(msg.reactions).length > 0 && (
                        <div className="reactions">
                          {Object.entries(msg.reactions).map(([emoji, users]) => (
                            <span
                              key={emoji}
                              className={`reaction ${users.includes(user.username) ? 'active' : ''}`}
                              onClick={() => react(msg.id, emoji)}
                              title={users.join(', ')}
                            >
                              {emoji} {users.length}
                            </span>
                          ))}
                        </div>
                      )}

                      {!msg.deleted && (
                        <div className="message-actions">
                          <button title="پاسخ" onClick={() => setReplyTo(msg)}><Reply size={14} /></button>
                          {EMOJIS.slice(0, 4).map((em) => (
                            <button key={em} onClick={() => react(msg.id, em)}>{em}</button>
                          ))}
                          {isOwn && (
                            <button title="حذف" onClick={() => deleteMsg(msg.id)}><Trash2 size={14} /></button>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
              <div ref={messagesEndRef} />
            </div>

            <div className="typing-indicator">
              {typingUsers.length > 0 &&
                `${typingUsers.map((t) => t.username).join('، ')} در حال نوشتن...`}
            </div>

            <div className="chat-input-area">
              {replyTo && (
                <div className="reply-bar">
                  <div className="reply-info">
                    <span>پاسخ به {replyTo.username}</span>
                    <span>{(replyTo.text || '').slice(0, 50)}</span>
                  </div>
                  <button onClick={() => setReplyTo(null)}><X size={16} /></button>
                </div>
              )}

              {showEmoji && (
                <div className="emoji-bar">
                  {EMOJIS.map((em) => (
                    <button key={em} onClick={() => setInput((p) => p + em)}>{em}</button>
                  ))}
                </div>
              )}

              <form className="chat-input" onSubmit={sendMessage}>
                <button type="button" className="attach-btn" onClick={() => fileInputRef.current?.click()} title="پیوست">
                  <Paperclip size={18} />
                </button>
                <input type="file" ref={fileInputRef} hidden onChange={handleFile} />
                <button type="button" className="attach-btn" onClick={() => setShowEmoji(!showEmoji)} title="ایموجی">
                  <Smile size={18} />
                </button>
                <textarea
                  value={input}
                  onChange={handleInputChange}
                  placeholder="پیام خود را بنویسید..."
                  rows={1}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      sendMessage();
                    }
                  }}
                />
                <button className="send-btn" type="submit" disabled={!input.trim()}>
                  <Send size={18} />
                </button>
              </form>
            </div>
          </>
        ) : (
          <div className="empty-state">
            <MessageCircle size={64} />
            <p>یک گفتگو را انتخاب کنید</p>
          </div>
        )}
      </main>

      {/* Online */}
      <aside className="online-panel">
        <h3>آنلاین — {onlineUsers.length}</h3>
        {onlineUsers.map((u) => (
          <div key={u.id} className="online-user">
            <div className="online-dot" />
            <div className="avatar sm">{u.username[0]}</div>
            <span>{u.username}</span>
          </div>
        ))}
      </aside>

      {/* Incoming call */}
      {incomingCall && !inCall && (
        <div className="call-overlay">
          <div className="incoming-call">
            <div className="avatar lg" style={{ margin: '0 auto 1rem' }}>
              {incomingCall.username[0]}
            </div>
            <h3>{incomingCall.username}</h3>
            <p>تماس {incomingCall.callType === 'video' ? 'تصویری' : 'صوتی'} ورودی</p>
            <div className="incoming-actions">
              <button className="btn btn-accept" onClick={acceptCall}>پذیرش</button>
              <button className="btn btn-reject" onClick={rejectCall}>رد</button>
            </div>
          </div>
        </div>
      )}

      {/* Active call */}
      {inCall && (
        <div className="call-overlay">
          <div className="call-videos">
            {localStream && (
              <div className="video-tile">
                <video ref={localVideoRef} autoPlay muted playsInline />
                <span className="label">شما {muted ? '(بی‌صدا)' : ''}</span>
              </div>
            )}
            {Object.entries(remoteStreams).map(([peerId, stream]) => (
              <RemoteVideo key={peerId} stream={stream} peerId={peerId} />
            ))}
          </div>
          <div className="call-controls">
            <button className={`icon-btn ${muted ? 'active' : ''}`} onClick={toggleMute}>
              {muted ? <MicOff size={22} /> : <Mic size={22} />}
            </button>
            {callType === 'video' && (
              <button className={`icon-btn ${videoOff ? 'active' : ''}`} onClick={toggleVideo}>
                {videoOff ? <VideoOff size={22} /> : <Video size={22} />}
              </button>
            )}
            <button className="icon-btn danger" onClick={endCall}>
              <PhoneOff size={22} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function RemoteVideo({ stream, peerId }) {
  const ref = useRef(null);
  useEffect(() => {
    if (ref.current) ref.current.srcObject = stream;
  }, [stream]);
  return (
    <div className="video-tile">
      <video ref={ref} autoPlay playsInline />
      <span className="label">کاربر {peerId.slice(0, 5)}</span>
    </div>
  );
}
