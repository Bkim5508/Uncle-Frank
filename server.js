const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const nameToSocket = new Map(); // name -> socketId
const socketToName = new Map(); // socketId -> name
// roomId -> { name, type, members: Set<name>, messages: [{sender, text, time}] }
const rooms = new Map();
// name -> { status, photo, color }
const profiles = new Map();
const COLOR_PALETTE = ['#E53935','#1E88E5','#43A047','#8E24AA','#FB8C00','#00ACC1','#D81B60','#6D4C41'];

// 메시지 배열에 발신자 색상 정보를 채워서 반환 (히스토리 전송 시 사용)
function enrichMessages(messages) {
  return messages.map(m => ({
    ...m,
    color: m.color || (profiles.get(m.sender) || {}).color || null
  }));
}

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'uncle-frank.html'));
});

io.on('connection', (socket) => {
  socket.on('login', (name) => {
    if (!name || typeof name !== 'string') return;
    name = name.trim().slice(0, 20);
    if (!name) return;

    // 중복 접속 시 이전 세션 종료
    if (nameToSocket.has(name)) {
      const old = io.sockets.sockets.get(nameToSocket.get(name));
      if (old && old.id !== socket.id) old.disconnect();
    }

    nameToSocket.set(name, socket.id);
    socketToName.set(socket.id, name);

    // 기존 대화방 재참여 + 히스토리 전송
    const userRooms = [];
    rooms.forEach((room, roomId) => {
      if (room.members.has(name)) {
        socket.join(roomId);
        userRooms.push({
          roomId, name: room.name, type: room.type,
          members: [...room.members], messages: enrichMessages(room.messages)
        });
      }
    });
    if (userRooms.length > 0) socket.emit('room_list', userRooms);

    // 첫 로그인 시 랜덤 색상 배정 (재접속 시 유지)
    if (!profiles.has(name)) {
      const color = COLOR_PALETTE[Math.floor(Math.random() * COLOR_PALETTE.length)];
      profiles.set(name, { status: '', photo: null, color });
    }
    // 내 색상을 본인에게만 전송
    socket.emit('my_profile', { color: profiles.get(name).color });

    // 다른 사용자들의 프로필 스냅샷 전송
    const snapshot = {};
    profiles.forEach((p, n) => { if (n !== name) snapshot[n] = p; });
    if (Object.keys(snapshot).length > 0) socket.emit('profiles_snapshot', snapshot);

    io.emit('users_updated', [...nameToSocket.keys()]);
  });

  socket.on('create_dm', ({ targetName }) => {
    const myName = socketToName.get(socket.id);
    if (!myName) return;
    const roomId = 'dm:' + [myName, targetName].sort().join('___');
    if (!rooms.has(roomId)) {
      rooms.set(roomId, { name: '', type: 'dm', members: new Set([myName, targetName]), messages: [] });
    }
    socket.join(roomId);
    const targetSocketId = nameToSocket.get(targetName);
    if (targetSocketId) {
      const ts = io.sockets.sockets.get(targetSocketId);
      if (ts) {
        ts.join(roomId);
        ts.emit('room_invited', {
          roomId, roomName: myName, type: 'dm',
          members: [myName, targetName], messages: enrichMessages(rooms.get(roomId).messages)
        });
      }
    }
    socket.emit('room_created', {
      roomId, roomName: targetName, type: 'dm',
      members: [myName, targetName], messages: enrichMessages(rooms.get(roomId).messages)
    });
  });

  socket.on('create_group', ({ name, memberNames }) => {
    const myName = socketToName.get(socket.id);
    if (!myName || !Array.isArray(memberNames)) return;
    const roomId = 'group:' + Date.now();
    const allMembers = [myName, ...memberNames];
    const roomName = (name || '').trim() || memberNames.join(', ') + ' 대화방';
    rooms.set(roomId, { name: roomName, type: 'group', members: new Set(allMembers), messages: [] });
    socket.join(roomId);
    memberNames.forEach(targetName => {
      const targetSocketId = nameToSocket.get(targetName);
      if (targetSocketId) {
        const ts = io.sockets.sockets.get(targetSocketId);
        if (ts) {
          ts.join(roomId);
          ts.emit('room_invited', { roomId, roomName, type: 'group', members: allMembers, messages: [] });
        }
      }
    });
    socket.emit('room_created', { roomId, roomName, type: 'group', members: allMembers, messages: [] });
  });

  socket.on('update_profile', ({ status, photo }) => {
    const name = socketToName.get(socket.id);
    if (!name) return;
    const cleanStatus = typeof status === 'string' ? status.trim().slice(0, 100) : '';
    const cleanPhoto = typeof photo === 'string' && photo.startsWith('data:image/') ? photo : null;
    const existing = profiles.get(name) || {};
    const color = existing.color || COLOR_PALETTE[0];
    profiles.set(name, { status: cleanStatus, photo: cleanPhoto, color });
    io.emit('profile_updated', { name, status: cleanStatus, photo: cleanPhoto, color });
  });

  socket.on('send_message', ({ roomId, text }) => {
    const senderName = socketToName.get(socket.id);
    if (!senderName || !rooms.has(roomId) || !text) return;
    text = String(text).trim().slice(0, 1000);
    if (!text) return;
    const now = new Date();
    const h = now.getHours(), m = String(now.getMinutes()).padStart(2, '0');
    const time = (h < 12 ? '오전' : '오후') + ' ' + (h % 12 || 12) + ':' + m;
    const senderColor = (profiles.get(senderName) || {}).color || null;
    const msg = { sender: senderName, text, time, color: senderColor };
    rooms.get(roomId).messages.push(msg);
    io.to(roomId).emit('message_received', { roomId, ...msg });
  });

  socket.on('disconnect', () => {
    const name = socketToName.get(socket.id);
    if (name) {
      socketToName.delete(socket.id);
      nameToSocket.delete(name);
      io.emit('users_updated', [...nameToSocket.keys()]);
    }
  });
});

server.listen(3000, () => console.log('Server running at http://localhost:3000'));
