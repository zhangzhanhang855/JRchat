const express = require('express');
const app = express();
const http = require('http');
const server = http.createServer(app);
const { Server } = require("socket.io");
const io = new Server(server, { maxHttpBufferSize: 5e6 }); 
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const mongoURI = process.env.MONGODB_URI;
mongoose.connect(mongoURI, { useNewUrlParser: true, useUnifiedTopology: true })
  .then(async () => {
    console.log('✅ 数据库连接成功');
    // 【系统初始化】：自动生成超级管理员账号
    const adminExists = await User.findOne({ username: 'admin' });
    if (!adminExists) {
      const salt = bcrypt.genSaltSync(10);
      const hashedPassword = bcrypt.hashSync('admin', salt);
      await new User({ username: 'admin', password: hashedPassword, role: 'admin' }).save();
      console.log('👑 超级管理员 admin 账号已就绪');
    }
  })
  .catch(err => console.error('❌ 数据库连接失败:', err));

// --- 数据库模型 ---
const userSchema = new mongoose.Schema({
  username: { type: String, unique: true, required: true },
  password: { type: String, required: true },
  friends: [String],
  groups: [{ groupId: String, groupName: String }],
  role: { type: String, default: 'user' }, // 'user' 或 'admin'
  isBanned: { type: Boolean, default: false } // 【新增】：封禁状态
});
const User = mongoose.model('User', userSchema);

const groupSchema = new mongoose.Schema({
  groupId: { type: String, unique: true },
  groupName: String,
  members: [String]
});
const Group = mongoose.model('Group', groupSchema);

const messageSchema = new mongoose.Schema({
  room: String,
  sender: String,
  text: String,
  msgType: { type: String, default: 'text' },
  timestamp: { type: Date, default: Date.now }
});
const Message = mongoose.model('Message', messageSchema);

// 【新增】：在线用户追踪器
const onlineUsers = new Map(); // socket.id -> username

app.get('/', (req, res) => { res.sendFile(__dirname + '/index.html'); });

io.on('connection', (socket) => {
  
  // 发送最新在线名单给所有人
  const broadcastOnlineStatus = () => {
    const activeUsernames = Array.from(new Set(onlineUsers.values()));
    io.emit('online status update', activeUsernames);
  };

  // 1. 注册与登录
  socket.on('register', async ({ username, password }) => {
    try {
      if (username.toLowerCase() === 'admin') return socket.emit('auth error', '保留关键字，无法注册！');
      const existingUser = await User.findOne({ username });
      if (existingUser) return socket.emit('auth error', '用户名已被抢占！');
      const salt = bcrypt.genSaltSync(10);
      const hashedPassword = bcrypt.hashSync(password, salt);
      const newUser = new User({ username, password: hashedPassword, groups: [{ groupId: 'General', groupName: '大厅' }] });
      await newUser.save();
      socket.emit('auth success', '注册成功，请登录！');
    } catch (err) { console.error(err); }
  });

  socket.on('login', async ({ username, password }) => {
    try {
      const user = await User.findOne({ username });
      if (!user) return socket.emit('auth error', '用户不存在！');
      
      // 【拦截】：检查是否被封禁
      if (user.isBanned) return socket.emit('auth error', '🚫 您的账号已被管理员封禁！');

      const isMatch = bcrypt.compareSync(password, user.password);
      if (!isMatch) return socket.emit('auth error', '密码错误！');
      
      // 记录在线状态
      onlineUsers.set(socket.id, user.username);
      socket.username = user.username; 
      broadcastOnlineStatus();

      socket.emit('login success', { username: user.username, friends: user.friends, groups: user.groups, role: user.role });
    } catch (err) { console.error(err); }
  });

  // 断开连接时更新在线状态
  socket.on('disconnect', () => {
    if (onlineUsers.has(socket.id)) {
      onlineUsers.delete(socket.id);
      broadcastOnlineStatus();
    }
  });

  // (常规的加群、加好友、退群等逻辑保持不变，为节省篇幅略去注释...)
  socket.on('create group', async ({ username, groupName }) => {
    const groupId = Math.floor(1000 + Math.random() * 9000).toString(); 
    await new Group({ groupId, groupName, members: [username] }).save();
    await User.updateOne({ username }, { $push: { groups: { groupId, groupName } } });
    socket.emit('system message', `群聊 [${groupName}] 创建成功！群号: ${groupId}`);
    socket.emit('update sidebar');
  });

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

  socket.on('add friend', async ({ username, friendName }) => {
    const friend = await User.findOne({ username: friendName });
    if (!friend) return socket.emit('system message', '找不到该用户！');
    const me = await User.findOne({ username });
    if (me.friends.includes(friendName)) return socket.emit('system message', '你们已经是好友了！');
    await User.updateOne({ username }, { $push: { friends: friendName } });
    await User.updateOne({ username: friendName }, { $push: { friends: username } });
    socket.emit('system message', `已添加 ${friendName} 为好友！`);
    socket.emit('update sidebar');
    
    // 如果对方在线，强制刷新他的侧边栏
    const friendSocketId = [...onlineUsers.entries()].find(([k, v]) => v === friendName)?.[0];
    if (friendSocketId) io.to(friendSocketId).emit('update sidebar');
  });

  socket.on('delete friend', async ({ username, friendName }) => {
    await User.updateOne({ username }, { $pull: { friends: friendName } });
    await User.updateOne({ username: friendName }, { $pull: { friends: username } });
    socket.emit('system message', `已删除好友: ${friendName}`);
    socket.emit('update sidebar');
  });

  socket.on('leave group', async ({ username, groupId }) => {
    if (groupId === 'General') return socket.emit('system message', '大厅是无法退出的哦！');
    await Group.updateOne({ groupId }, { $pull: { members: username } });
    await User.updateOne({ username }, { $pull: { groups: { groupId } } });
    socket.emit('system message', `已退出群聊`);
    socket.emit('update sidebar');
  });

  socket.on('clear history', async (room) => {
    await Message.deleteMany({ room });
    io.to(room).emit('history cleared'); 
  });

  socket.on('join room', async (roomName) => {
    Array.from(socket.rooms).forEach(r => { if (r !== socket.id) socket.leave(r); });
    socket.join(roomName);
    const history = await Message.find({ room: roomName }).sort({ timestamp: 1 }).limit(100);
    socket.emit('load history', history);
  });

  socket.on('chat message', async (msgData) => {
    const newMessage = new Message(msgData);
    await newMessage.save();
    io.to(msgData.room).emit('chat message', msgData);
  });

  // ==========================================
  // 👑 上帝模式（Admin 专属接口）
  // ==========================================
  const checkAdmin = async (username) => {
    const user = await User.findOne({ username });
    return user && user.role === 'admin';
  };

  // 获取全局数据总览
  socket.on('admin fetch data', async (adminUser) => {
    if (!(await checkAdmin(adminUser))) return;
    const users = await User.find({}, { password: 0 }); // 不传密文密码给前端
    const groups = await Group.find({});
    socket.emit('admin data loaded', { users, groups });
  });

  // 封禁 / 解封用户
  socket.on('admin toggle ban', async ({ adminUser, targetUser, banStatus }) => {
    if (!(await checkAdmin(adminUser)) || targetUser === 'admin') return;
    await User.updateOne({ username: targetUser }, { isBanned: banStatus });
    socket.emit('system message', `已${banStatus ? '封禁' : '解封'}用户：${targetUser}`);
    
    // 如果被封禁且在线，直接踢下线
    if (banStatus) {
      const targetSocketId = [...onlineUsers.entries()].find(([k, v]) => v === targetUser)?.[0];
      if (targetSocketId) {
        io.to(targetSocketId).emit('auth error', '您已被管理员强行踢出并封禁！');
        io.sockets.sockets.get(targetSocketId)?.disconnect(true);
      }
    }
  });

  // 强制修改用户密码
  socket.on('admin reset password', async ({ adminUser, targetUser, newPassword }) => {
    if (!(await checkAdmin(adminUser))) return;
    const salt = bcrypt.genSaltSync(10);
    const hashedPassword = bcrypt.hashSync(newPassword, salt);
    await User.updateOne({ username: targetUser }, { password: hashedPassword });
    socket.emit('system message', `已将 ${targetUser} 的密码重置！`);
  });

  // 强制偷窥任意房间记录
  socket.on('admin fetch room history', async ({ adminUser, roomId }) => {
    if (!(await checkAdmin(adminUser))) return;
    const history = await Message.find({ room: roomId }).sort({ timestamp: 1 }).limit(200);
    socket.emit('admin room history loaded', history);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => { console.log(`Server running on port ${PORT}`); });
