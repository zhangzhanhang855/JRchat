const express = require('express');
const app = express();
const http = require('http');
const server = http.createServer(app);
const { Server } = require("socket.io");
const otplib = require('otplib');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const io = new Server(server, { maxHttpBufferSize: 5e6, cors: { origin: "*" } }); 

const mongoURI = process.env.MONGODB_URI;

mongoose.connect(mongoURI, { useNewUrlParser: true, useUnifiedTopology: true })
  .then(async () => {
    console.log('✅ MongoDB 连接成功');
    try {
      const adminExists = await User.findOne({ username: 'admin' });
      if (!adminExists) {
        const salt = bcrypt.genSaltSync(10);
        await new User({ username: 'admin', email: 'admin@jrchat.com', password: bcrypt.hashSync('admin', salt), role: 'admin', groups: [{ groupId: 'General', groupName: '大厅' }] }).save();
      }
    } catch (e) { 
      console.error('初始化 admin 失败:', e);
    }
  }).catch(err => console.error('❌ MongoDB 连接失败:', err));

// ==========================================================================
// 数据库模型 (Schemas)
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
  twoFactorEnabled: { type: Boolean, default: false },
  passkeyId: { type: String, default: '' },
  hasPasskey: { type: Boolean, default: false }
});
const User = mongoose.model('User', userSchema);

const groupSchema = new mongoose.Schema({ groupId: { type: String, unique: true }, groupName: String, members: [String] });
const Group = mongoose.model('Group', groupSchema);

const messageSchema = new mongoose.Schema({ room: String, sender: String, text: String, msgType: { type: String, default: 'text' }, timestamp: { type: Date, default: Date.now } });
const Message = mongoose.model('Message', messageSchema);

const momentSchema = new mongoose.Schema({
  username: String,
  content: String,
  likes: [String], 
  comments: [{ username: String, text: String, timestamp: { type: Date, default: Date.now } }],
  timestamp: { type: Date, default: Date.now }
});
const Moment = mongoose.model('Moment', momentSchema);

const onlineUsers = new Map(); 
const sessionTokens = new Map(); 
const getSocketIdByUsername = (username) => [...onlineUsers.entries()].find(([k, v]) => v === username)?.[0];

app.get('/', (req, res) => { res.sendFile(__dirname + '/index.html'); });

io.on('connection', (socket) => {
  const broadcastOnlineStatus = () => io.emit('online status update', Array.from(new Set(onlineUsers.values())));

  const finishLogin = (user, socketObj, token) => {
    onlineUsers.set(socketObj.id, user.username); socketObj.username = user.username; broadcastOnlineStatus(); 
    socketObj.emit('login success', { username: user.username, friends: user.friends, groups: user.groups, role: user.role, avatar: user.avatar, sessionToken: token, hasPasskey: user.hasPasskey, twoFactorEnabled: user.twoFactorEnabled });
  };

  // --------------------------------------------------------
  // A. 身份验证与 Passkey 系统
  // --------------------------------------------------------
  socket.on('register', async ({ username, email, password }) => {
    try {
      if (username.toLowerCase() === 'admin') return socket.emit('auth error', '保留账户，无法注册！');
      if (!email) return socket.emit('auth error', '请填写安全邮箱！');
      if (await User.findOne({ username })) return socket.emit('auth error', '代号已被抢占！');
      const hashedPassword = bcrypt.hashSync(password, bcrypt.genSaltSync(10));
      await new User({ username, email, password: hashedPassword, groups: [{ groupId: 'General', groupName: '大厅' }] }).save();
      socket.emit('auth success', '身份创建成功！初次登录将要求绑定身份验证器。');
    } catch (err) { 
      console.error('注册错误:', err);
      socket.emit('auth error', '系统错误'); 
    }
  });

  socket.on('login', async ({ username, password, sessionToken }) => {
    try {
      const user = await User.findOne({ username });
      if (!user) return socket.emit('auth error', '该特工不存在！');
      if (user.isBanned) return socket.emit('auth error', '账户已被强制封禁！');

      if (sessionToken && sessionTokens.get(username) === sessionToken) {
        return finishLogin(user, socket, sessionToken);
      }

      if (!password) return socket.emit('auth error', '请输入密钥！');
      const isMatch = bcrypt.compareSync(password, user.password);
      if (!isMatch) return socket.emit('auth error', '密钥不匹配！');

      if (!user.twoFactorEnabled) return socket.emit('2fa setup required', { secret: otplib.authenticator.generateSecret() });
      socket.emit('2fa verification required');
    } catch (err) {
      console.error('登录错误:', err);
    }
  });

  socket.on('setup 2fa', async ({ username, password, secret, code }) => {
    try {
      const user = await User.findOne({ username });
      if (otplib.authenticator.check(code, secret)) {
        user.twoFactorSecret = secret; user.twoFactorEnabled = true; await user.save();
        const newToken = Math.random().toString(36).substring(2); sessionTokens.set(username, newToken);
        finishLogin(user, socket, newToken);
      } else socket.emit('auth error', '动态验证码错误');
    } catch (e) { console.error('2FA设置错误:', e); }
  });

  socket.on('verify 2fa', async ({ username, password, code }) => {
    try {
      const user = await User.findOne({ username });
      if (otplib.authenticator.check(code, user.twoFactorSecret)) {
        const newToken = Math.random().toString(36).substring(2); sessionTokens.set(username, newToken);
        finishLogin(user, socket, newToken);
      } else socket.emit('auth error', '验证码错误或已过期');
    } catch (e) { console.error('2FA验证错误:', e); }
  });

  socket.on('request passkey login', async ({ username }) => {
    try {
      const user = await User.findOne({ username });
      if (!user) return socket.emit('auth error', '未找到账户');
      if (!user.hasPasskey) return socket.emit('auth error', '该账户尚未配置通行密钥');
      socket.emit('passkey challenge', { challenge: Math.random().toString(36), passkeyId: user.passkeyId });
    } catch (e) { console.error('请求通行密钥错误:', e); }
  });

  socket.on('verify passkey', async ({ username, credentialId }) => {
    try {
      const user = await User.findOne({ username });
      if (user && user.passkeyId === credentialId) {
        const newToken = Math.random().toString(36).substring(2); sessionTokens.set(username, newToken);
        finishLogin(user, socket, newToken);
      } else socket.emit('auth error', '通行密钥不匹配！');
    } catch (e) { console.error('验证通行密钥错误:', e); }
  });

  socket.on('setup passkey', async ({ username, credentialId }) => {
    try {
      await User.updateOne({ username }, { passkeyId: credentialId, hasPasskey: true });
      socket.emit('passkey status updated', true);
    } catch (e) { console.error('设置通行密钥错误:', e); }
  });

  socket.on('disconnect', () => { if (onlineUsers.has(socket.id)) { onlineUsers.delete(socket.id); broadcastOnlineStatus(); } });

  // --------------------------------------------------------
  // B. 朋友圈 (Moments) 逻辑
  // --------------------------------------------------------
  socket.on('fetch moments', async () => {
    try {
      const moments = await Moment.find().sort({ timestamp: -1 }).limit(50).lean();
      for (let m of moments) { const u = await User.findOne({ username: m.username }); m.avatar = u ? u.avatar : ''; }
      socket.emit('moments loaded', moments);
    } catch (e) { console.error('获取朋友圈错误:', e); }
  });

  socket.on('post moment', async ({ username, content }) => {
    try {
      const m = new Moment({ username, content }); await m.save();
      const u = await User.findOne({ username }); const mObj = m.toObject(); mObj.avatar = u ? u.avatar : '';
      io.emit('new moment', mObj);
    } catch (e) { console.error('发布朋友圈错误:', e); }
  });

  socket.on('like moment', async ({ username, momentId }) => {
    try {
      const m = await Moment.findById(momentId);
      if (m.likes.includes(username)) m.likes = m.likes.filter(u => u !== username); else m.likes.push(username);
      await m.save(); io.emit('update moment', m);
    } catch (e) { console.error('点赞朋友圈错误:', e); }
  });

  socket.on('comment moment', async ({ username, momentId, text }) => {
    try {
      const m = await Moment.findById(momentId); m.comments.push({ username, text }); await m.save();
      io.emit('update moment', m);
    } catch (e) { console.error('评论朋友圈错误:', e); }
  });

  // --------------------------------------------------------
  // C. 其它操作 (资料、好友、群组)
  // --------------------------------------------------------
  socket.on('request password reset', async ({ username, email }) => { try { const user = await User.findOne({ username, email }); if (!user) return socket.emit('auth error', '用户名与邮箱不匹配！'); const code = Math.floor(100000 + Math.random() * 900000).toString(); user.resetCode = code; user.resetCodeExpiry = Date.now() + 15 * 60 * 1000; await user.save(); socket.emit('system message', `【模拟】验证码已发至 ${email}`); socket.emit('reset code received', code); } catch (err) { console.error('请求重置密码错误:', err); }});
  socket.on('execute password reset', async ({ username, code, newPassword }) => { try { const user = await User.findOne({ username, resetCode: code }); if (!user) return socket.emit('auth error', '验证码错误！'); user.password = bcrypt.hashSync(newPassword, bcrypt.genSaltSync(10)); user.resetCode = ''; await user.save(); socket.emit('auth success', '重设成功！'); } catch (err) { console.error('执行重置密码错误:', err); } });
  
  socket.on('fetch profile', async ({ targetUser }) => { try { const user = await User.findOne({ username: targetUser }, { password: 0 }); if (!user) return; socket.emit('profile data loaded', { username: user.username, email: user.email, avatar: user.avatar, bio: user.bio, role: user.role, isOnline: Array.from(onlineUsers.values()).includes(targetUser) }); } catch (e) { console.error('获取资料错误:', e); } });
  socket.on('update profile', async ({ username, bio, avatar }) => { try { const updates = {}; if(bio!==undefined) updates.bio=bio; if(avatar!==undefined) updates.avatar=avatar; await User.updateOne({ username }, updates); socket.emit('profile updated'); } catch (e) { console.error('更新资料错误:', e); } });
  socket.on('download account data', async ({ username }) => { try { socket.emit('account data ready', { accountInfo: await User.findOne({ username }, { password: 0 }), messagesHistory: await Message.find({ sender: username }) }); } catch (e) { console.error('下载数据错误:', e); } });
  
  socket.on('create group', async ({ username, groupName }) => { try { const groupId = Math.floor(1000+Math.random()*9000).toString(); await new Group({ groupId, groupName, members: [username] }).save(); await User.updateOne({ username }, { $push: { groups: { groupId, groupName } } }); socket.emit('update sidebar'); } catch(e){ console.error('创建群组错误:', e); } });
  
  socket.on('join group by id', async ({ username, groupId }) => { 
    try { 
      const group=await Group.findOne({groupId}); 
      if(!group) { const sid = getSocketIdByUsername(username); if(sid) io.to(sid).emit('system message', '无效的群组识别码！'); return; }
      if(group.members.includes(username)) return; 
      group.members.push(username); await group.save(); 
      await User.updateOne({username},{$push:{groups:{groupId:group.groupId,groupName:group.groupName}}}); 
      socket.emit('update sidebar'); 
      const sid = getSocketIdByUsername(username); if(sid) io.to(sid).emit('system message', '已成功接入群组通讯！');
    } catch(e){ console.error('加入群组错误:', e); } 
  });
  
  socket.on('add friend', async ({ username, friendName }) => { 
    try { 
      if(username===friendName) return; 
      const friend = await User.findOne({ username: friendName });
      if(!friend) { const sid = getSocketIdByUsername(username); if(sid) io.to(sid).emit('system message', '未找到该特工代号！'); return; }
      if(friend.friends && friend.friends.includes(username)) return;
      await User.updateOne({username},{$push:{friends:friendName}}); 
      await User.updateOne({username:friendName},{$push:{friends:username}}); 
      socket.emit('update sidebar'); 
      const f=getSocketIdByUsername(friendName); if(f)io.to(f).emit('update sidebar'); 
      const sid = getSocketIdByUsername(username); if(sid) io.to(sid).emit('system message', '已建立双向私人连接！');
    } catch(e){ console.error('添加好友错误:', e); } 
  });
  
  socket.on('delete friend', async ({ username, friendName }) => { try { await User.updateOne({username},{$pull:{friends:friendName}}); await User.updateOne({username:friendName},{$pull:{friends:username}}); socket.emit('update sidebar'); const f=getSocketIdByUsername(friendName); if(f)io.to(f).emit('update sidebar'); } catch(e){ console.error('删除好友错误:', e); } });
  socket.on('leave group', async ({ username, groupId }) => { try { await Group.updateOne({groupId},{$pull:{members:username}}); await User.updateOne({username},{$pull:{groups:{groupId}}}); socket.emit('update sidebar'); } catch(e){ console.error('退出群组错误:', e); } });
  socket.on('clear history', async (room) => { try { await Message.deleteMany({room}); io.to(room).emit('history cleared'); } catch(e){ console.error('清空记录错误:', e); } });

  // --------------------------------------------------------
  // D. 房间调度与消息广播机制 (核心修复区)
  // --------------------------------------------------------
  socket.on('join room', async (roomName) => { 
    try { 
      // 离开之前加入的房间（除了自己的专属 socket.id 房间）
      Array.from(socket.rooms).forEach(r => { 
        if(r !== socket.id) socket.leave(r); 
      }); 
      
      // 加入新房间
      socket.join(roomName); 
      console.log(`📡 特工 [${socket.username || socket.id}] 成功接入通讯频道: ${roomName}`);
      
      // 加载历史记录
      const history = await Message.find({ room: roomName }).sort({ timestamp: 1 }).limit(150);
      socket.emit('load history', history); 
    } catch(e) {
      console.error('❌ 频道接入过程发生异常:', e);
    } 
  });

  socket.on('chat message', async (msgData) => { 
    try { 
      // 1. 拦截异常数据：如果连房间号都没有，直接阻断
      if (!msgData.room) {
        console.warn('⚠️ 拦截到无频道的异常数据:', msgData);
        return;
      }

      // 2. 存入云端数据库
      await new Message(msgData).save(); 
      console.log(`💾 消息入库成功 -> 频道 [${msgData.room}] | 发送者 [${msgData.sender}]`);

      // 3. 执行广播（发送给所有当前已执行 join_room 进入该频道的特工）
      io.to(msgData.room).emit('chat message', msgData); 

      // 4. 【增强机制：私聊强推通知】
      if (msgData.targetUser) {
        const targetSocketId = getSocketIdByUsername(msgData.targetUser);
        if (targetSocketId) {
          const roomSockets = io.sockets.adapter.rooms.get(msgData.room);
          // 如果对方在线，但没有加入当前聊天频道（比如正在看大厅），则发送一条全局通知
          if (!roomSockets || !roomSockets.has(targetSocketId)) {
            io.to(targetSocketId).emit('new message notification', msgData);
          }
        }
      }
    } catch(e) {
      console.error('❌ 消息处理与广播全链路崩溃:', e);
    } 
  });

  // --------------------------------------------------------
  // E. WebRTC 视频通话
  // --------------------------------------------------------
  socket.on('call request', ({ caller, target }) => { const t = getSocketIdByUsername(target); if(t) io.to(t).emit('incoming call', { caller }); else socket.emit('call error', '对方不在线'); });
  socket.on('call response', ({ caller, callee, accepted }) => { const c = getSocketIdByUsername(caller); if(c) io.to(c).emit('call response', { callee, accepted }); });
  socket.on('webrtc signal', ({ sender, target, signal }) => { const t = getSocketIdByUsername(target); if(t) io.to(t).emit('webrtc signal', { sender, signal }); });
  socket.on('end call', ({ sender, target }) => { const t = getSocketIdByUsername(target); if(t) io.to(t).emit('call ended', { sender }); });

});

server.listen(process.env.PORT || 3000, () => { console.log(`🚀 JR Ecosystem 启动完毕`); });
