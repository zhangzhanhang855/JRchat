const express = require('express');
const app = express();
const http = require('http');
const server = http.createServer(app);
const { Server } = require("socket.io");
const io = new Server(server);
const mongoose = require('mongoose');

// 1. 连接 MongoDB 数据库
// 这里使用环境变量，千万不要把真实的数据库密码明文写在代码里传到 GitHub！
const mongoURI = process.env.MONGODB_URI;

mongoose.connect(mongoURI, { useNewUrlParser: true, useUnifiedTopology: true })
  .then(() => console.log('✅ 成功连接到 MongoDB 云数据库'))
  .catch(err => console.error('❌ 数据库连接失败:', err));

// 2. 定义聊天记录的数据格式 (Schema)
const messageSchema = new mongoose.Schema({
  room: String,
  sender: String,
  text: String,
  timestamp: { type: Date, default: Date.now } // 自动记录发送时间
});
const Message = mongoose.model('Message', messageSchema);

app.get('/', (req, res) => {
  res.sendFile(__dirname + '/index.html');
});

io.on('connection', (socket) => {
  
  // 监听加入群聊
  socket.on('join room', async (roomName) => {
    Array.from(socket.rooms).forEach(r => {
      if (r !== socket.id) socket.leave(r);
    });
    socket.join(roomName);
    
    try {
      // 【核心修改】从数据库中查找当前房间的最新 100 条历史记录，按时间正序排列
      const history = await Message.find({ room: roomName })
                                   .sort({ timestamp: 1 })
                                   .limit(100);
      socket.emit('load history', history);
    } catch (err) {
      console.error('获取历史记录失败', err);
    }
  });

  // 监听发送新消息
  socket.on('chat message', async (msgData) => {
    const room = msgData.room;
    
    try {
      // 【核心修改】把新消息存入真正的数据库
      const newMessage = new Message({
        room: room,
        sender: msgData.sender,
        text: msgData.text
      });
      await newMessage.save();

      // 存完之后，广播给房间里的所有人
      io.to(room).emit('chat message', msgData);
    } catch (err) {
      console.error('保存消息失败', err);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
