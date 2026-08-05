import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import { v4 as uuidv4 } from 'uuid';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  maxHttpBufferSize: 10e6
});

// ========== Storage ==========
const UPLOAD_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const db = new Database(path.join(__dirname, 'chat.db'));
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    avatar TEXT,
    status TEXT DEFAULT 'offline',
    last_seen INTEGER,
    created_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS rooms (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    type TEXT DEFAULT 'group',
    description TEXT,
    created_by TEXT,
    created_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS memberships (
    room_id TEXT,
    user_id TEXT,
    role TEXT DEFAULT 'member',
    joined_at INTEGER,
    PRIMARY KEY (room_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    username TEXT NOT NULL,
    text TEXT,
    type TEXT DEFAULT 'text',
    reply_to TEXT,
    file_url TEXT,
    file_name TEXT,
    file_size INTEGER,
    reactions TEXT DEFAULT '{}',
    edited INTEGER DEFAULT 0,
    deleted INTEGER DEFAULT 0,
    timestamp INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_messages_room ON messages(room_id, timestamp);
`);

// Seed default rooms
const seedRooms = [
  { id: 'general', name: 'عمومی', type: 'group', description: 'چت عمومی همه' },
  { id: 'random', name: 'رندوم', type: 'group', description: 'حرفای متفرقه' },
  { id: 'news', name: 'اخبار', type: 'channel', description: 'کانال اخبار (فقط ادمین می‌تونه پیام بده)' }
];
const insertRoom = db.prepare('INSERT OR IGNORE INTO rooms (id, name, type, description, created_at) VALUES (?, ?, ?, ?, ?)');
seedRooms.forEach(r => insertRoom.run(r.id, r.name, r.type, r.description, Date.now()));

// ========== Multer ==========
const storage = multer.diskStorage({
  destination: UPLOAD_DIR,
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${uuidv4()}${ext}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = /jpeg|jpg|png|gif|webp|mp4|webm|mp3|ogg|wav|pdf|doc|docx|zip|rar|txt/;
    const ext = allowed.test(path.extname(file.originalname).toLowerCase());
    const mime = allowed.test(file.mimetype) || file.mimetype.startsWith('image/') || file.mimetype.startsWith('video/') || file.mimetype.startsWith('audio/');
    cb(null, ext || mime);
  }
});

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use('/uploads', express.static(UPLOAD_DIR));

// ========== REST APIs ==========
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', version: '2.0' });
});

app.get('/api/rooms', (req, res) => {
  const rooms = db.prepare(`
    SELECT r.*, COUNT(m.user_id) as member_count
    FROM rooms r LEFT JOIN memberships m ON r.id = m.room_id
    GROUP BY r.id ORDER BY r.created_at
  `).all();
  res.json(rooms);
});

app.get('/api/rooms/:id/messages', (req, res) => {
  const { before, limit = 50, q } = req.query;
  let sql = `SELECT * FROM messages WHERE room_id = ? AND deleted = 0`;
  const params = [req.params.id];
  if (q) {
    sql += ` AND text LIKE ?`;
    params.push(`%${q}%`);
  }
  if (before) {
    sql += ` AND timestamp < ?`;
    params.push(Number(before));
  }
  sql += ` ORDER BY timestamp DESC LIMIT ?`;
  params.push(Number(limit));
  const rows = db.prepare(sql).all(...params).reverse();
  res.json(rows.map(m => ({
    ...m,
    reactions: JSON.parse(m.reactions || '{}')
  })));
});

app.post('/api/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  res.json({
    url: `/uploads/${req.file.filename}`,
    name: req.file.originalname,
    size: req.file.size,
    type: req.file.mimetype
  });
});

// ========== In-memory presence ==========
const onlineUsers = new Map(); // socketId -> { id, username, avatar, status }
const socketToUser = new Map(); // socketId -> userId (db id)

// ========== Socket.IO ==========
io.on('connection', (socket) => {
  console.log('connect', socket.id);

  socket.on('join', ({ username, avatar }) => {
    if (!username || username.trim().length < 2) {
      socket.emit('error', { message: 'نام کاربری باید حداقل ۲ کاراکتر باشد' });
      return;
    }
    const uname = username.trim().slice(0, 32);

    // Find or create user
    let user = db.prepare('SELECT * FROM users WHERE username = ?').get(uname);
    if (!user) {
      const id = uuidv4();
      db.prepare('INSERT INTO users (id, username, avatar, status, last_seen, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(id, uname, avatar || null, 'online', Date.now(), Date.now());
      user = { id, username: uname, avatar: avatar || null };
    } else {
      db.prepare('UPDATE users SET status = ?, last_seen = ? WHERE id = ?')
        .run('online', Date.now(), user.id);
    }

    onlineUsers.set(socket.id, {
      id: user.id,
      username: user.username,
      avatar: user.avatar,
      status: 'online',
      socketId: socket.id
    });
    socketToUser.set(socket.id, user.id);

    // Auto-join default rooms
    ['general', 'random'].forEach(rid => {
      db.prepare('INSERT OR IGNORE INTO memberships (room_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)')
        .run(rid, user.id, 'member', Date.now());
      socket.join(rid);
    });

    const rooms = db.prepare(`
      SELECT r.*, COUNT(m.user_id) as member_count
      FROM rooms r LEFT JOIN memberships m ON r.id = m.room_id
      GROUP BY r.id
    `).all();

    socket.emit('joined', {
      user: { id: user.id, username: user.username, avatar: user.avatar },
      rooms
    });

    broadcastOnline();
  });

  socket.on('join-room', (roomId) => {
    const userId = socketToUser.get(socket.id);
    if (!userId) return;
    const room = db.prepare('SELECT * FROM rooms WHERE id = ?').get(roomId);
    if (!room) return;

    db.prepare('INSERT OR IGNORE INTO memberships (room_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)')
      .run(roomId, userId, 'member', Date.now());
    socket.join(roomId);

    const messages = db.prepare(`
      SELECT * FROM messages WHERE room_id = ? AND deleted = 0
      ORDER BY timestamp DESC LIMIT 60
    `).all(roomId).reverse().map(m => ({
      ...m,
      reactions: JSON.parse(m.reactions || '{}')
    }));

    const members = db.prepare(`
      SELECT u.id, u.username, u.avatar, u.status
      FROM memberships m JOIN users u ON m.user_id = u.id
      WHERE m.room_id = ?
    `).all(roomId);

    socket.emit('room-joined', {
      roomId,
      name: room.name,
      type: room.type,
      description: room.description,
      messages,
      members
    });

    const ou = onlineUsers.get(socket.id);
    socket.to(roomId).emit('member-joined', { roomId, user: ou });
  });

  socket.on('create-room', ({ name, type = 'group', description }) => {
    const userId = socketToUser.get(socket.id);
    if (!userId || !name?.trim()) return;
    const id = uuidv4().slice(0, 10);
    const now = Date.now();
    db.prepare('INSERT INTO rooms (id, name, type, description, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, name.trim().slice(0, 60), type, description || '', userId, now);
    db.prepare('INSERT INTO memberships (room_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)')
      .run(id, userId, 'admin', now);

    const room = { id, name: name.trim(), type, description, member_count: 1 };
    io.emit('room-created', room);
    socket.join(id);
    socket.emit('room-joined', {
      roomId: id,
      name: room.name,
      type,
      description,
      messages: [],
      members: [onlineUsers.get(socket.id)]
    });
  });

  socket.on('message', (data) => {
    const userId = socketToUser.get(socket.id);
    const user = onlineUsers.get(socket.id);
    if (!userId || !user || !data.roomId) return;

    const room = db.prepare('SELECT * FROM rooms WHERE id = ?').get(data.roomId);
    if (!room) return;

    // Channel: only admins can post
    if (room.type === 'channel') {
      const mem = db.prepare('SELECT role FROM memberships WHERE room_id = ? AND user_id = ?').get(data.roomId, userId);
      if (!mem || mem.role !== 'admin') {
        socket.emit('error', { message: 'فقط ادمین کانال می‌تواند پیام بفرستد' });
        return;
      }
    }

    const msg = {
      id: uuidv4(),
      room_id: data.roomId,
      user_id: userId,
      username: user.username,
      text: (data.text || '').slice(0, 4000),
      type: data.type || 'text',
      reply_to: data.replyTo || null,
      file_url: data.fileUrl || null,
      file_name: data.fileName || null,
      file_size: data.fileSize || null,
      reactions: '{}',
      edited: 0,
      deleted: 0,
      timestamp: Date.now()
    };

    db.prepare(`
      INSERT INTO messages (id, room_id, user_id, username, text, type, reply_to, file_url, file_name, file_size, reactions, edited, deleted, timestamp)
      VALUES (@id, @room_id, @user_id, @username, @text, @type, @reply_to, @file_url, @file_name, @file_size, @reactions, @edited, @deleted, @timestamp)
    `).run(msg);

    const out = { ...msg, reactions: {} };
    io.to(data.roomId).emit('message', out);
  });

  socket.on('edit-message', ({ messageId, text }) => {
    const userId = socketToUser.get(socket.id);
    if (!userId || !text) return;
    const msg = db.prepare('SELECT * FROM messages WHERE id = ?').get(messageId);
    if (!msg || msg.user_id !== userId) return;
    db.prepare('UPDATE messages SET text = ?, edited = 1 WHERE id = ?').run(text.slice(0, 4000), messageId);
    io.to(msg.room_id).emit('message-edited', { id: messageId, text: text.slice(0, 4000), edited: 1 });
  });

  socket.on('delete-message', ({ messageId }) => {
    const userId = socketToUser.get(socket.id);
    if (!userId) return;
    const msg = db.prepare('SELECT * FROM messages WHERE id = ?').get(messageId);
    if (!msg || msg.user_id !== userId) return;
    db.prepare('UPDATE messages SET deleted = 1, text = ? WHERE id = ?').run('این پیام حذف شد', messageId);
    io.to(msg.room_id).emit('message-deleted', { id: messageId });
  });

  socket.on('react', ({ messageId, emoji }) => {
    const userId = socketToUser.get(socket.id);
    const user = onlineUsers.get(socket.id);
    if (!userId || !emoji) return;
    const msg = db.prepare('SELECT * FROM messages WHERE id = ?').get(messageId);
    if (!msg) return;
    let reactions = JSON.parse(msg.reactions || '{}');
    if (!reactions[emoji]) reactions[emoji] = [];
    const idx = reactions[emoji].indexOf(user.username);
    if (idx >= 0) {
      reactions[emoji].splice(idx, 1);
      if (reactions[emoji].length === 0) delete reactions[emoji];
    } else {
      reactions[emoji].push(user.username);
    }
    db.prepare('UPDATE messages SET reactions = ? WHERE id = ?').run(JSON.stringify(reactions), messageId);
    io.to(msg.room_id).emit('reaction-updated', { id: messageId, reactions });
  });

  socket.on('typing', ({ roomId, isTyping }) => {
    const user = onlineUsers.get(socket.id);
    if (!user) return;
    socket.to(roomId).emit('typing', {
      userId: user.id,
      username: user.username,
      isTyping
    });
  });

  socket.on('search', ({ roomId, query }) => {
    if (!query || query.length < 2) return;
    const rows = db.prepare(`
      SELECT * FROM messages WHERE room_id = ? AND deleted = 0 AND text LIKE ?
      ORDER BY timestamp DESC LIMIT 30
    `).all(roomId, `%${query}%`);
    socket.emit('search-results', rows.map(m => ({ ...m, reactions: JSON.parse(m.reactions || '{}') })));
  });

  // ========== WebRTC Signaling ==========
  socket.on('call-offer', ({ roomId, offer, callType, to }) => {
    const user = onlineUsers.get(socket.id);
    if (!user) return;
    const payload = { from: user.id, socketId: socket.id, username: user.username, offer, callType: callType || 'video' };
    if (to) {
      // Find socket of target
      for (const [sid, u] of onlineUsers) {
        if (u.id === to) {
          io.to(sid).emit('call-offer', payload);
          return;
        }
      }
    } else {
      socket.to(roomId).emit('call-offer', payload);
    }
  });

  socket.on('call-answer', ({ to, answer }) => {
    const user = onlineUsers.get(socket.id);
    if (!user) return;
    for (const [sid, u] of onlineUsers) {
      if (u.id === to || sid === to) {
        io.to(sid).emit('call-answer', { from: user.id, socketId: socket.id, username: user.username, answer });
        return;
      }
    }
  });

  socket.on('ice-candidate', ({ to, candidate }) => {
    for (const [sid, u] of onlineUsers) {
      if (u.id === to || sid === to) {
        io.to(sid).emit('ice-candidate', { from: socket.id, candidate });
        return;
      }
    }
  });

  socket.on('call-end', ({ roomId, to }) => {
    const user = onlineUsers.get(socket.id);
    if (to) {
      for (const [sid, u] of onlineUsers) {
        if (u.id === to || sid === to) {
          io.to(sid).emit('call-end', { from: user?.id });
          return;
        }
      }
    } else if (roomId) {
      socket.to(roomId).emit('call-end', { from: user?.id });
    }
  });

  socket.on('call-reject', ({ to }) => {
    const user = onlineUsers.get(socket.id);
    for (const [sid, u] of onlineUsers) {
      if (u.id === to || sid === to) {
        io.to(sid).emit('call-reject', { from: user?.id });
        return;
      }
    }
  });

  socket.on('disconnect', () => {
    const user = onlineUsers.get(socket.id);
    const userId = socketToUser.get(socket.id);
    if (userId) {
      db.prepare('UPDATE users SET status = ?, last_seen = ? WHERE id = ?')
        .run('offline', Date.now(), userId);
    }
    onlineUsers.delete(socket.id);
    socketToUser.delete(socket.id);
    if (user) {
      io.emit('user-left', user.id);
      broadcastOnline();
    }
  });
});

function broadcastOnline() {
  const list = Array.from(onlineUsers.values()).map(u => ({
    id: u.id,
    username: u.username,
    avatar: u.avatar,
    status: u.status
  }));
  // unique by id
  const unique = [...new Map(list.map(u => [u.id, u])).values()];
  io.emit('user-list', unique);
}

const PORT = process.env.PORT || 3001;
httpServer.listen(PORT, () => {
  console.log(`🚀 Server v2 running on http://localhost:${PORT}`);
});
