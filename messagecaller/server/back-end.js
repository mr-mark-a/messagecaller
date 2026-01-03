const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const cors = require('cors');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIO(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '..')));

// In-memory storage for users and messages
const users = new Map(); // userId -> {number, nickname, lastname, photo, socketId}
const messages = new Map(); // chatId -> [{from, to, text, timestamp}]
const activeConnections = new Map(); // socketId -> userId

// Serve the front-end
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'front-end.html'));
});

// Socket.IO connection
io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  // Register user
  socket.on('register', (userData) => {
    const { number, nickname, lastname, photo } = userData;
    
    // Check if number is 4 digits
    if (!number || number.length !== 4 || !/^\d{4}$/.test(number)) {
      socket.emit('error', { message: 'Number must be exactly 4 digits' });
      return;
    }

    // Check if number already exists
    const existingUser = Array.from(users.values()).find(u => u.number === number);
    if (existingUser && existingUser.socketId !== socket.id) {
      socket.emit('error', { message: 'This number is already taken' });
      return;
    }

    const userId = number;
    users.set(userId, {
      number,
      nickname: nickname || 'User',
      lastname: lastname || '',
      photo: photo || '',
      socketId: socket.id
    });
    activeConnections.set(socket.id, userId);

    socket.emit('registered', {
      userId,
      user: users.get(userId)
    });

    console.log('User registered:', userId, nickname);
  });

  // Update profile
  socket.on('updateProfile', (profileData) => {
    const userId = activeConnections.get(socket.id);
    if (!userId) {
      socket.emit('error', { message: 'Not registered' });
      return;
    }

    const user = users.get(userId);
    if (profileData.nickname !== undefined) user.nickname = profileData.nickname;
    if (profileData.lastname !== undefined) user.lastname = profileData.lastname;
    if (profileData.photo !== undefined) user.photo = profileData.photo;

    socket.emit('profileUpdated', { user });
  });

  // Get user by number
  socket.on('getUserByNumber', (number) => {
    const user = Array.from(users.values()).find(u => u.number === number);
    if (user) {
      socket.emit('userFound', {
        number: user.number,
        nickname: user.nickname,
        lastname: user.lastname,
        photo: user.photo
      });
    } else {
      socket.emit('userNotFound', { number });
    }
  });

  // Send message
  socket.on('sendMessage', (messageData) => {
    const { to, text } = messageData;
    const fromUserId = activeConnections.get(socket.id);
    
    if (!fromUserId) {
      socket.emit('error', { message: 'Not registered' });
      return;
    }

    const toUser = Array.from(users.values()).find(u => u.number === to);
    if (!toUser) {
      socket.emit('error', { message: 'Recipient not found' });
      return;
    }

    const message = {
      from: fromUserId,
      to: to,
      text,
      timestamp: Date.now()
    };

    // Create chat ID (sorted to maintain consistency)
    const chatId = [fromUserId, to].sort().join('-');
    
    if (!messages.has(chatId)) {
      messages.set(chatId, []);
    }
    messages.get(chatId).push(message);

    // Send to sender
    socket.emit('messageSent', message);

    // Send to recipient if online
    if (toUser.socketId) {
      io.to(toUser.socketId).emit('messageReceived', message);
    }

    console.log('Message sent from', fromUserId, 'to', to);
  });

  // Get chat history
  socket.on('getChatHistory', (targetNumber) => {
    const userId = activeConnections.get(socket.id);
    if (!userId) {
      socket.emit('error', { message: 'Not registered' });
      return;
    }

    const chatId = [userId, targetNumber].sort().join('-');
    const chatHistory = messages.get(chatId) || [];
    
    socket.emit('chatHistory', {
      targetNumber,
      messages: chatHistory
    });
  });

  // Initiate call
  socket.on('initiateCall', (data) => {
    const { to, offer } = data;
    const fromUserId = activeConnections.get(socket.id);
    
    if (!fromUserId) return;

    const toUser = Array.from(users.values()).find(u => u.number === to);
    if (toUser && toUser.socketId) {
      const fromUser = users.get(fromUserId);
      io.to(toUser.socketId).emit('incomingCall', {
        from: fromUserId,
        caller: {
          nickname: fromUser.nickname,
          lastname: fromUser.lastname,
          photo: fromUser.photo
        },
        offer
      });
    }
  });

  // Answer call
  socket.on('answerCall', (data) => {
    const { to, answer } = data;
    const fromUserId = activeConnections.get(socket.id);
    
    if (!fromUserId) return;

    const toUser = Array.from(users.values()).find(u => u.number === to);
    if (toUser && toUser.socketId) {
      io.to(toUser.socketId).emit('callAnswered', {
        from: fromUserId,
        answer
      });
    }
  });

  // ICE candidate
  socket.on('iceCandidate', (data) => {
    const { to, candidate } = data;
    const toUser = Array.from(users.values()).find(u => u.number === to);
    if (toUser && toUser.socketId) {
      io.to(toUser.socketId).emit('iceCandidate', {
        from: activeConnections.get(socket.id),
        candidate
      });
    }
  });

  // End call
  socket.on('endCall', (data) => {
    const { to } = data;
    const toUser = Array.from(users.values()).find(u => u.number === to);
    if (toUser && toUser.socketId) {
      io.to(toUser.socketId).emit('callEnded', {
        from: activeConnections.get(socket.id)
      });
    }
  });

  // Disconnect
  socket.on('disconnect', () => {
    const userId = activeConnections.get(socket.id);
    if (userId) {
      const user = users.get(userId);
      if (user) {
        user.socketId = null; // Mark as offline but keep data
      }
      activeConnections.delete(socket.id);
    }
    console.log('User disconnected:', socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
