const express = require('express');
const app = express();
const http = require('http');
const server = http.createServer(app);
const { Server } = require("socket.io");
const io = new Server(server);

// 【升级】：为不同的群聊建立独立的历史记录数组
const roomHistory = {
  '大厅': [],
  '极客技术': [],
  '日常摸鱼': []
};

app.get('/', (req, res) => {
  res.sendFile(__dirname + '/index.html');
});

io.on('connection', (socket) => {
  
  // 监听用户加入特定群聊的请求
  socket.on('join room', (roomName) => {
    // 退出之前所在的所有房间（除了自己的默认 ID 房间）
    Array.from(socket.rooms).forEach(r => {
      if (r !== socket.id) socket.leave(r);
    });

    // 加入新房间
    socket.join(roomName);
    
    // 如果这个房间还没有历史记录数组，就初始化一个
    if (!roomHistory[roomName]) roomHistory[roomName] = [];
    
    // 只把当前房间的历史记录发送给这个用户
    socket.emit('load history', roomHistory[roomName]);
  });

  // 监听消息并只广播给指定房间
  socket.on('chat message', (msgData) => {
    const room = msgData.room;
    
    // 记录到对应房间的记事本
    if (!roomHistory[room]) roomHistory[room] = [];
    roomHistory[room].push(msgData);
    if (roomHistory[room].length > 100) roomHistory[room].shift();

    // io.to(room) 表示只对这个房间里的人广播
    io.to(room).emit('chat message', msgData);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
