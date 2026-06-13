const express = require('express');
const app = express();
const http = require('http');
const server = http.createServer(app);
const { Server } = require("socket.io");
const io = new Server(server);

// 临时保存聊天记录的“记事本”（内存数组）
const messageHistory = []; 

app.get('/', (req, res) => {
  res.sendFile(__dirname + '/index.html');
});

io.on('connection', (socket) => {
  // 当有新用户连接时，立刻把记事本里的历史记录全发给他
  socket.emit('load history', messageHistory);

  socket.on('chat message', (msgData) => {
    // 收到新消息时，先抄写到记事本里
    messageHistory.push(msgData);
    
    // 为了防止内存撑爆，只保留最近的 100 条记录
    if (messageHistory.length > 100) messageHistory.shift();

    // 广播给所有人
    io.emit('chat message', msgData);
  });
});

// 监听 Render 分配的端口，本地测试回退到 3000
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
