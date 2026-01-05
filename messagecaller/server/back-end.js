const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const cors = require('cors');
const path = require('path');
const nodemailer = require('nodemailer');

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

// Email transporter configuration (configure with your SMTP settings)
const emailTransporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'smtp.gmail.com',
  port: process.env.SMTP_PORT || 587,
  secure: false,
  auth: {
    user: process.env.EMAIL_USER || 'your-email@gmail.com',
    pass: process.env.EMAIL_PASS || 'your-app-password'
  }
});

// Encode text to numbers: A=1, B=2, ... Z=26, space=0, others=char code
function encodeToNumbers(text) {
  return text.split('').map(char => {
    const upper = char.toUpperCase();
    if (char === ' ') return '0';
    if (upper >= 'A' && upper <= 'Z') {
      return (upper.charCodeAt(0) - 64).toString();
    }
    return char.charCodeAt(0).toString();
  }).join('-');
}

// Decode numbers to text
function decodeFromNumbers(encoded) {
  return encoded.split('-').map(num => {
    const n = parseInt(num);
    if (n === 0) return ' ';
    if (n >= 1 && n <= 26) {
      return String.fromCharCode(n + 64);
    }
    return String.fromCharCode(n);
  }).join('');
}

// In-memory storage for users and messages
const users = new Map(); // userId -> {number, nickname, lastname, photo, socketId}
const messages = new Map(); // chatId -> [{from, to, text, timestamp}]
const activeConnections = new Map(); // socketId -> userId
const signInRequests = new Map(); // requestId -> {number, requestingSocketId}

// Serve the front-end
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'front-end.html'));
});

// API endpoint to encode text to numbers
app.post('/api/encode', (req, res) => {
  const { text } = req.body;
  if (!text) {
    return res.status(400).json({ error: 'Text is required' });
  }
  const encoded = encodeToNumbers(text);
  res.json({ encoded });
});

// API endpoint to decode numbers to text
app.post('/api/decode', (req, res) => {
  const { encoded } = req.body;
  if (!encoded) {
    return res.status(400).json({ error: 'Encoded text is required' });
  }
  try {
    const decoded = decodeFromNumbers(encoded);
    res.json({ decoded });
  } catch (error) {
    res.status(400).json({ error: 'Invalid encoded format' });
  }
});

// Socket.IO connection
io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  // Register user
  socket.on('register', (userData) => {
    const { number, nickname, lastname, photo, age, email, phone, birthday } = userData;
    
    // Check if number is 4 digits
    if (!number || number.length !== 4 || !/^\d{4}$/.test(number)) {
      socket.emit('error', { message: 'Number must be exactly 4 digits' });
      return;
    }

    const userId = number;
    const existingUser = users.get(userId);
    
    // If account already exists, sign in instead of creating new account
    if (existingUser) {
      // Check if user is already logged in on another device
      if (existingUser.socketId) {
        // User is logged in elsewhere, request authorization
        const requestId = Date.now().toString();
        signInRequests.set(requestId, {
          number: number,
          requestingSocketId: socket.id
        });

        io.to(existingUser.socketId).emit('signInRequest', { requestId });
        socket.emit('awaitingAuthorization', { message: 'Waiting for authorization from your other device...' });
        console.log('Sign-in request sent to existing session for:', userId);
      } else {
        // No active session, allow direct sign-in
        existingUser.socketId = socket.id;
        activeConnections.set(socket.id, userId);

        socket.emit('registered', {
          userId,
          user: existingUser
        });

        console.log('User signed in (auto-login from register):', userId);
      }
      return;
    }

    // Create new account
    users.set(userId, {
      number,
      nickname: nickname || 'User',
      lastname: lastname || '',
      photo: photo || '',
      age: age || 0,
      email: email || '',
      phone: phone || '',
      birthday: birthday || '',
      socketId: socket.id
    });
    activeConnections.set(socket.id, userId);

    socket.emit('registered', {
      userId,
      user: users.get(userId)
    });

    console.log('User registered:', userId, nickname);
  });

  // Approve sign-in
  socket.on('approveSignIn', (data) => {
    const { requestId } = data;
    const request = signInRequests.get(requestId);
    
    if (!request) {
      return;
    }

    const userId = activeConnections.get(socket.id);
    if (!userId) {
      return;
    }

    const user = users.get(userId);
    
    // Update socket ID to new device
    user.socketId = request.requestingSocketId;
    activeConnections.delete(socket.id);
    activeConnections.set(request.requestingSocketId, userId);

    // Notify new device
    io.to(request.requestingSocketId).emit('signInApproved', {
      userId,
      user
    });

    signInRequests.delete(requestId);
    console.log('Sign-in approved for:', userId);
  });

  // Deny sign-in
  socket.on('denySignIn', (data) => {
    const { requestId } = data;
    const request = signInRequests.get(requestId);
    
    if (!request) {
      return;
    }

    io.to(request.requestingSocketId).emit('signInDenied');
    signInRequests.delete(requestId);
    console.log('Sign-in denied');
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
    if (profileData.age !== undefined) user.age = profileData.age;
    if (profileData.email !== undefined) user.email = profileData.email;
    if (profileData.phone !== undefined) user.phone = profileData.phone;
    if (profileData.birthday !== undefined) user.birthday = profileData.birthday;

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

    // Send email notification with encoded message if recipient has email
    if (toUser.email && toUser.email.trim() !== '') {
      const encodedMessage = encodeToNumbers(text);
      const fromUser = users.get(fromUserId);
      
      const mailOptions = {
        from: process.env.EMAIL_USER || 'messagecaller@example.com',
        to: toUser.email,
        subject: `Message from ${fromUser.nickname} (${fromUser.number})`,
        html: `
          <div style="font-family: Arial, sans-serif; padding: 20px;">
            <h2>New Message from ${fromUser.nickname} ${fromUser.lastname || ''}</h2>
            <p><strong>User Code:</strong> ${fromUser.number}</p>
            <hr>
            <p><strong>Message (Original):</strong></p>
            <p style="background: #f0f0f0; padding: 15px; border-radius: 5px;">${text}</p>
            <hr>
            <p><strong>Encoded Message:</strong></p>
            <p style="background: #e8f5e9; padding: 15px; border-radius: 5px; font-family: monospace;">${encodedMessage}</p>
            <hr>
            <p style="color: #666; font-size: 12px;">Reply to this message on MessageCaller app</p>
          </div>
        `
      };

      emailTransporter.sendMail(mailOptions, (error, info) => {
        if (error) {
          console.log('Email send error:', error);
        } else {
          console.log('Email sent:', info.response);
        }
      });
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
