const express = require('express');
const app = express();
const http = require('http');
const server = http.createServer(app);
const { Server } = require("socket.io");

const io = new Server(server, { 
  maxHttpBufferSize: 5e6,
  cors: { origin: "*" }
}); 

const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

// 【修改】：只保留 otplib，不再需要 qrcode
const otplib = require('otplib');

const mongoURI = process.env.MONGODB_URI;

mongoose.connect(mongoURI, { useNewUrlParser: true, useUnifiedTopology: true })
  .then(async () => {
    console.log('✅ MongoDB 数据库连接成功');
    try {
      const adminExists = await User.findOne({ username: 'admin' });
      if (!adminExists) {
        const salt = bcrypt.genSaltSync(10);
        const hashedPassword = bcrypt.hashSync('admin', salt);
        await new User({ 
          username: 'admin', 
          email: 'admin@jrchat.com',
          password: hashedPassword, 
          role: 'admin',
          groups: [{ groupId: 'General', groupName: '大厅' }]
        }).save();
        console.log('👑 超级管理员 admin 账号初始化完成');
      }
    } catch (e) { console.error('管理员账号创建失败:', e); }
  })
  .catch(err => console.error('❌ MongoDB 数据库连接失败:', err));

// ==========================================================================
// 2. 数据库模型 (Schemas)
// ==========================================================================
const userSchema = new mongoose.Schema({
  username: { type: String, unique: true, required: true },
  email: { type: String }, 
  password: { type: String, required: true },
  avatar: { type: String, default: '' },
  bio: { type: String, default: '这位特工很神秘，什么都没写。' },
  friends: [String], 
  groups: [{ groupId: String, groupName: String }], 
  role: { type: String, default: 'user' }, 
  isBanned: { type: Boolean, default: false },
  resetCode: { type: String, default: '' }, 
  resetCodeExpiry: { type: Date },
  
  twoFactorSecret: { type: String, default: '' }, 
  twoFactorEnabled: { type: Boolean, default: false }
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

// 内存状态追踪与安全会话令牌
const onlineUsers = new Map(); 
const sessionTokens = new Map(); 

const getSocketIdByUsername = (username) => {
  return [...onlineUsers.entries()].find(([k, v]) => v === username)?.[0];
};

app.get('/', (req, res) => { res.sendFile(__dirname + '/index.html'); });

// ==========================================================================
// 3. WebSocket 核心业务逻辑
// ==========================================================================
io.on('connection', (socket) => {
  
  const broadcastOnlineStatus = () => {
    const activeUsernames = Array.from(new Set(onlineUsers.values()));
    io.emit('online status update', activeUsernames);
  };

  const finishLogin = (user, socketObj, token) => {
    onlineUsers.set(socketObj.id, user.username);
    socketObj.username = user.username; 
    broadcastOnlineStatus(); 
    socketObj.emit('login success', { 
        username: user.username, friends: user.friends, groups: user.groups, role: user.role, avatar: user.avatar, sessionToken: token 
    });
  };

  // --------------------------------------------------------
  // A. 身份验证系统 (含 2FA)
  // --------------------------------------------------------
  socket.on('register', async ({ username, email, password }) => {
    try {
      if (username.toLowerCase() === 'admin') return socket.emit('auth error', '保留账户，无法注册！');
      if (!email) return socket.emit('auth error', '请填写安全邮箱以保障账户安全！');
      const existingUser = await User.findOne({ username });
      if (existingUser) return socket.emit('auth error', '代号已被抢占！');
      
      const salt = bcrypt.genSaltSync(10);
      const hashedPassword = bcrypt.hashSync(password, salt);
      
      await new User({ username, email, password: hashedPassword, groups: [{ groupId: 'General', groupName: '大厅' }] }).save();
      socket.emit('auth success', '身份创建成功！初次登录将要求绑定身份验证器。');
    } catch (err) { socket.emit('auth error', '注册时发生错误'); }
  });

  socket.on('login', async ({ username, password, sessionToken }) => {
    try {
      const user = await User.findOne({ username });
      if (!user) return socket.emit('auth error', '该特工不存在！');
      if (user.isBanned) return socket.emit('auth error', '🚫 警告：账户已被强制封禁！');

      const isMatch = bcrypt.compareSync(password, user.password);
      if (!isMatch) return socket.emit('auth error', '存取密钥不匹配！');

      // 1. 强制要求绑定 2FA (去掉二维码，只发 Secret)
      if (!user.twoFactorEnabled) {
        const secret = otplib.authenticator.generateSecret();
        return socket.emit('2fa setup required', { secret });
      }

      // 2. 验证 Session Token 放行后台静默刷新
      if (sessionToken && sessionTokens.get(username) === sessionToken) {
        return finishLogin(user, socket, sessionToken);
      }

      // 3. 手动登录，强制验证 2FA 动态密码
      socket.emit('2fa verification required');

    } catch (err) { console.error('登录错误:', err); }
  });

  socket.on('setup 2fa', async ({ username, password, secret, code }) => {
    try {
      const user = await User.findOne({ username });
      if (!user || !bcrypt.compareSync(password, user.password)) return socket.emit('auth error', '非法请求');
      
      const isValid = otplib.authenticator.check(code, secret);
      if (isValid) {
        user.twoFactorSecret = secret;
        user.twoFactorEnabled = true;
        await user.save();
        
        const newToken = Math.random().toString(36).substring(2);
        sessionTokens.set(username, newToken);
        finishLogin(user, socket, newToken);
      } else {
        socket.emit('auth error', '动态验证码错误');
      }
    } catch (e) { socket.emit('auth error', '系统错误'); }
  });

  socket.on('verify 2fa', async ({ username, password, code }) => {
    try {
      const user = await User.findOne({ username });
      if (!user || !bcrypt.compareSync(password, user.password)) return socket.emit('auth error', '非法请求');
      
      const isValid = otplib.authenticator.check(code, user.twoFactorSecret);
      if (isValid) {
        const newToken = Math.random().toString(36).substring(2);
        sessionTokens.set(username, newToken);
        finishLogin(user, socket, newToken);
      } else {
        socket.emit('auth error', '动态验证码错误或已过期');
      }
    } catch (e) { socket.emit('auth error', '系统错误'); }
  });

  // 忘记密码相关
  socket.on('request password reset', async ({ username, email }) => {
    try {
      const user = await User.findOne({ username, email });
      if (!user) return socket.emit('auth error', '用户名与邮箱不匹配或不存在！');
      const code = Math.floor(100000 + Math.random() * 900000).toString();
      user.resetCode = code; user.resetCodeExpiry = Date.now() + 15 * 60 * 1000;
      await user.save();
      socket.emit('system message', `【系统模拟】已发送验证码至 ${email}`);
      socket.emit('reset code received', code); 
    } catch (err) { socket.emit('auth error', '系统错误'); }
  });

  socket.on('execute password reset', async ({ username, code, newPassword }) => {
    try {
      const user = await User.findOne({ username, resetCode: code });
      if (!user) return socket.emit('auth error', '验证码错误或失效！');
      if (user.resetCodeExpiry < Date.now()) return socket.emit('auth error', '验证码已过期！');
      const salt = bcrypt.genSaltSync(10);
      user.password = bcrypt.hashSync(newPassword, salt);
      user.resetCode = ''; await user.save();
      socket.emit('auth success', '密钥重设成功！');
    } catch (err) { socket.emit('auth error', '系统错误'); }
  });

  socket.on('disconnect', () => {
    if (onlineUsers.has(socket.id)) {
      onlineUsers.delete(socket.id);
      broadcastOnlineStatus(); 
    }
  });

  // --------------------------------------------------------
  // B. 个人档案与数据导出
  // --------------------------------------------------------
  socket.on('fetch profile', async ({ targetUser }) => {
    try {
      const user = await User.findOne({ username: targetUser }, { password: 0, resetCode: 0, twoFactorSecret: 0 });
      if (!user) return socket.emit('system message', '找不到该档案');
      const isOnline = Array.from(onlineUsers.values()).includes(targetUser);
      socket.emit('profile data loaded', { username: user.username, email: user.email, avatar: user.avatar, bio: user.bio, role: user.role, isOnline });
    } catch (e) {}
  });

  socket.on('update profile', async ({ username, bio, avatar }) => {
    try {
      const updates = {}; if(bio !== undefined) updates.bio = bio; if(avatar !== undefined) updates.avatar = avatar;
      await User.updateOne({ username }, updates);
      socket.emit('system message', '档案已更新！'); socket.emit('profile updated');
    } catch (e) { socket.emit('system message', '更新失败'); }
  });

  socket.on('download account data', async ({ username }) => {
    try {
      const user = await User.findOne({ username }, { password: 0, twoFactorSecret: 0 });
      const messages = await Message.find({ sender: username });
      socket.emit('account data ready', { accountInfo: user, messagesHistory: messages, exportedAt: new Date().toISOString() });
    } catch (e) { socket.emit('system message', '打包失败'); }
  });

  // --------------------------------------------------------
  // C. 房间、好友与聊天
  // --------------------------------------------------------
  socket.on('create group', async ({ username, groupName }) => {
    try {
      const groupId = Math.floor(1000 + Math.random() * 9000).toString(); 
      await new Group({ groupId, groupName, members: [username] }).save();
      await User.updateOne({ username }, { $push: { groups: { groupId, groupName } } });
      socket.emit('system message', `群组 [${groupName}] 创建成功！代码: ${groupId}`);
      socket.emit('update sidebar'); 
    } catch (e) {}
  });

  socket.on('join group by id', async ({ username, groupId }) => {
    try {
      const group = await Group.findOne({ groupId });
      if (!group) return socket.emit('system message', '代码错误！');
      if (group.members.includes(username)) return socket.emit('system message', '已在该群组中！');
      group.members.push(username); await group.save();
      await User.updateOne({ username }, { $push: { groups: { groupId: group.groupId, groupName: group.groupName } } });
      socket.emit('system message', `已加入: ${group.groupName}`); socket.emit('update sidebar');
    } catch (e) {}
  });

  socket.on('add friend', async ({ username, friendName }) => {
    try {
      if(username === friendName) return;
      const friend = await User.findOne({ username: friendName });
      if (!friend) return socket.emit('system message', '目标不存在！');
      const me = await User.findOne({ username });
      if (me.friends.includes(friendName)) return socket.emit('system message', '已是好友。');
      await User.updateOne({ username }, { $push: { friends: friendName } });
      await User.updateOne({ username: friendName }, { $push: { friends: username } });
      socket.emit('system message', `与 ${friendName} 成为好友！`); socket.emit('update sidebar');
      const friendSocketId = getSocketIdByUsername(friendName); if (friendSocketId) io.to(friendSocketId).emit('update sidebar');
    } catch (e) {}
  });

  socket.on('delete friend', async ({ username, friendName }) => {
    try {
      await User.updateOne({ username }, { $pull: { friends: friendName } });
      await User.updateOne({ username: friendName }, { $pull: { friends: username } });
      socket.emit('system message', `已删除好友 ${friendName}。`); socket.emit('update sidebar');
      const friendSocketId = getSocketIdByUsername(friendName); if (friendSocketId) io.to(friendSocketId).emit('update sidebar');
    } catch (e) {}
  });

  socket.on('leave group', async ({ username, groupId }) => {
    try {
      if (groupId === 'General') return;
      await Group.updateOne({ groupId }, { $pull: { members: username } });
      await User.updateOne({ username }, { $pull: { groups: { groupId } } });
      socket.emit('system message', `已退出群组。`); socket.emit('update sidebar');
    } catch (e) {}
  });

  socket.on('clear history', async (room) => { try { await Message.deleteMany({ room }); io.to(room).emit('history cleared'); } catch (e) {} });

  socket.on('join room', async (roomName) => {
    try {
      Array.from(socket.rooms).forEach(r => { if (r !== socket.id) socket.leave(r); });
      socket.join(roomName);
      const history = await Message.find({ room: roomName }).sort({ timestamp: 1 }).limit(150);
      socket.emit('load history', history);
    } catch (e) {}
  });

  socket.on('chat message', async (msgData) => {
    try { const newMessage = new Message(msgData); await newMessage.save(); io.to(msgData.room).emit('chat message', msgData); } catch (e) {}
  });

  // --------------------------------------------------------
  // D. WebRTC 语音通话 
  // --------------------------------------------------------
  socket.on('call request', ({ caller, target }) => { const targetId = getSocketIdByUsername(target); if (targetId) { io.to(targetId).emit('incoming call', { caller }); } else { socket.emit('call error', '对方不在线。'); } });
  socket.on('call response', ({ caller, callee, accepted }) => { const callerId = getSocketIdByUsername(caller); if (callerId) { io.to(callerId).emit('call response', { callee, accepted }); } });
  socket.on('webrtc signal', ({ sender, target, signal }) => { const targetId = getSocketIdByUsername(target); if (targetId) { io.to(targetId).emit('webrtc signal', { sender, signal }); } });
  socket.on('end call', ({ sender, target }) => { const targetId = getSocketIdByUsername(target); if (targetId) { io.to(targetId).emit('call ended', { sender }); } });

  // --------------------------------------------------------
  // E. Admin 上帝控制台
  // --------------------------------------------------------
  const checkAdmin = async (username) => { return (await User.findOne({ username }))?.role === 'admin'; };
  socket.on('admin fetch data', async (adminUser) => { if (!(await checkAdmin(adminUser))) return; const users = await User.find({}, { password: 0, resetCode: 0, twoFactorSecret: 0 }); const groups = await Group.find({}); socket.emit('admin data loaded', { users, groups }); });
  socket.on('admin toggle ban', async ({ adminUser, targetUser, banStatus }) => {
    if (!(await checkAdmin(adminUser)) || targetUser === 'admin') return; await User.updateOne({ username: targetUser }, { isBanned: banStatus }); socket.emit('system message', `已${banStatus ? '封禁' : '解封'}：${targetUser}`);
    if (banStatus) { const targetSocketId = getSocketIdByUsername(targetUser); if (targetSocketId) { io.to(targetSocketId).emit('auth error', '您的访问权限已被强制终止！'); io.sockets.sockets.get(targetSocketId)?.disconnect(true); } }
  });
  socket.on('admin reset password', async ({ adminUser, targetUser, newPassword }) => { if (!(await checkAdmin(adminUser))) return; const salt = bcrypt.genSaltSync(10); const hashedPassword = bcrypt.hashSync(newPassword, salt); await User.updateOne({ username: targetUser }, { password: hashedPassword }); socket.emit('system message', `强制修改 ${targetUser} 密码成功！`); });
  socket.on('admin fetch room history', async ({ adminUser, roomId }) => { if (!(await checkAdmin(adminUser))) return; const history = await Message.find({ room: roomId }).sort({ timestamp: 1 }).limit(200); socket.emit('admin room history loaded', history); });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => { console.log(`🚀 JR Chat 运行于 ${PORT}`); });
