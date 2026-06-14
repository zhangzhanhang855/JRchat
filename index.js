const express = require('express');
const app = express();
const http = require('http');
const server = http.createServer(app);
const { Server } = require("socket.io");
const io = new Server(server);
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs'); // 引入加密库

const mongoURI = process.env.MONGODB_URI;
mongoose.connect(mongoURI, { useNewUrlParser: true, useUnifiedTopology: true })
  .then(() => console.log('✅ 数据库连接成功'))
  .catch(err => console.error('❌ 数据库连接失败:', err));

// --- 数据库模型 (Schemas) ---
// 1. 用户表
const userSchema = new mongoose.Schema({
  username: { type: String, unique: true, required: true },
  password: { type: String, required: true },
  friends: [String], // 存放好友用户名
  groups: [{ groupId: String, groupName: String }] // 存放加入的群聊
});
const User = mongoose.model('User', userSchema);

// 2. 群组表
const groupSchema = new mongoose.Schema({
  groupId: { type: String, unique: true }, // 比如 "8848"
  groupName: String,
  members: [String]
});
const Group = mongoose.model('Group', groupSchema);

// 3. 消息表
const messageSchema = new mongoose.Schema({
  room: String,
  sender: String,
  text: String,
  timestamp: { type: Date, default: Date.now }
});
const Message = mongoose.model('Message', messageSchema);

app.get('/', (req, res) => { res.sendFile(__dirname + '/index.html'); });

// --- 核心业务逻辑 ---
io.on('connection', (socket) => {
  
  // 【1. 注册逻辑】
  socket.on('register', async ({ username, password }) => {
    try {
      const existingUser = await User.findOne({ username });
      if (existingUser) return socket.emit('auth error', '用户名已被抢占啦！');
      
      const salt = bcrypt.genSaltSync(10);
      const hashedPassword = bcrypt.hashSync(password, salt);
      
      const newUser = new User({ 
        username, 
        password: hashedPassword,
        groups: [{ groupId: 'General', groupName: '大厅' }] // 默认加入大厅
      });
      await newUser.save();
      socket.emit('auth success', '注册成功，请登录！');
    } catch (err) { console.error(err); }
  });

  // 【2. 登录逻辑】
  socket.on('login', async ({ username, password }) => {
    try {
      const user = await User.findOne({ username });
      if (!user) return socket.emit('auth error', '用户不存在！');
      
      const isMatch = bcrypt.compareSync(password, user.password);
      if (!isMatch) return socket.emit('auth error', '密码错误！');

      // 登录成功，把用户的群组和好友名单发给前端
      socket.emit('login success', { 
        username: user.username, 
        friends: user.friends, 
        groups: user.groups 
      });
    } catch (err) { console.error(err); }
  });

  // 【3. 创建群聊】
  socket.on('create group', async ({ username, groupName }) => {
    // 生成 4 位随机群号
    const groupId = Math.floor(1000 + Math.random() * 9000).toString(); 
    const newGroup = new Group({ groupId, groupName, members: [username] });
    await newGroup.save();

    await User.updateOne({ username }, { $push: { groups: { groupId, groupName } } });
    socket.emit('system message', `群聊 [${groupName}] 创建成功！群号: ${groupId}`);
    socket.emit('update sidebar'); // 通知前端刷新列表
  });

  // 【4. 加入群聊】
  socket.on('join group by id', async ({ username, groupId }) => {
    const group = await Group.findOne({ groupId });
    if (!group) return socket.emit('system message', '群号不存在！');
    if (group.members.includes(username)) return socket.emit('system message', '你已经在群里了！');

    group.members.push(username);
    await group.save();
    await User.updateOne({ username }, { $push: { groups: { groupId: group.groupId, groupName: group.groupName } } });
    
    socket.emit('system message', `成功加入群聊: ${group.groupName}`);
    socket.emit('update sidebar');
  });

  // 【5. 添加好友】
  socket.on('add friend', async ({ username, friendName }) => {
    const friend = await User.findOne({ username: friendName });
    if (!friend) return socket.emit('system message', '找不到该用户！');
    
    const me = await User.findOne({ username });
    if (me.friends.includes(friendName)) return socket.emit('system message', '你们已经是好友了！');

    // 双向添加
    await User.updateOne({ username }, { $push: { friends: friendName } });
    await User.updateOne({ username: friendName }, { $push: { friends: username } });
    
    socket.emit('system message', `已添加 ${friendName} 为好友！`);
    socket.emit('update sidebar');
  });

  // 【6. 加入房间并获取历史记录】
  socket.on('join room', async (roomName) => {
    Array.from(socket.rooms).forEach(r => { if (r !== socket.id) socket.leave(r); });
    socket.join(roomName);
    const history = await Message.find({ room: roomName }).sort({ timestamp: 1 }).limit(100);
    socket.emit('load history', history);
  });

  // 【7. 发送消息】
  socket.on('chat message', async (msgData) => {
    const newMessage = new Message(msgData);
    await newMessage.save();
    io.to(msgData.room).emit('chat message', msgData);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => { console.log(`Server running on port ${PORT}`); });
