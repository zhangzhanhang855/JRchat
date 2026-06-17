const express = require('express');
const app = express();
const http = require('http');
const server = http.createServer(app);
const { Server } = require("socket.io");

const io = new Server(server, { 
  maxHttpBufferSize: 5e6, // 允許最大 5MB 傳輸
  cors: { origin: "*" }
}); 

const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

// ==========================================================================
// 1. MongoDB 資料庫連線與初始化
// ==========================================================================
const mongoURI = process.env.MONGODB_URI;

mongoose.connect(mongoURI, { useNewUrlParser: true, useUnifiedTopology: true })
  .then(async () => {
    console.log('✅ MongoDB 資料庫連線成功');
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
          groups: [{ groupId: 'General', groupName: '大廳' }]
        }).save();
        console.log('👑 超級管理員 admin 帳號初始化完成');
      }
    } catch (e) { console.error('管理員帳號建立失敗:', e); }
  })
  .catch(err => console.error('❌ MongoDB 資料庫連線失敗:', err));

// ==========================================================================
// 2. 資料庫模型 (Schemas) 升級
// ==========================================================================
const userSchema = new mongoose.Schema({
  username: { type: String, unique: true, required: true },
  email: { type: String }, // 【新增】：信箱
  password: { type: String, required: true },
  avatar: { type: String, default: '' }, // 【新增】：自訂頭像 (Base64)
  bio: { type: String, default: '這位特工很神祕，什麼都沒寫。' }, // 【新增】：個性簽名
  friends: [String], 
  groups: [{ groupId: String, groupName: String }], 
  role: { type: String, default: 'user' }, 
  isBanned: { type: Boolean, default: false },
  resetCode: { type: String, default: '' }, // 【新增】：忘記密碼驗證碼
  resetCodeExpiry: { type: Date } // 【新增】：驗證碼過期時間
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

// 記憶體狀態追蹤
const onlineUsers = new Map(); 
const getSocketIdByUsername = (username) => {
  return [...onlineUsers.entries()].find(([k, v]) => v === username)?.[0];
};

app.get('/', (req, res) => { res.sendFile(__dirname + '/index.html'); });

// ==========================================================================
// 3. WebSocket 核心業務邏輯
// ==========================================================================
io.on('connection', (socket) => {
  
  const broadcastOnlineStatus = () => {
    const activeUsernames = Array.from(new Set(onlineUsers.values()));
    io.emit('online status update', activeUsernames);
  };

  // --------------------------------------------------------
  // A. 驗證系統 (註冊、登入、忘記密碼)
  // --------------------------------------------------------
  socket.on('register', async ({ username, email, password }) => {
    try {
      if (username.toLowerCase() === 'admin') return socket.emit('auth error', '保留帳戶，無法註冊！');
      if (!email) return socket.emit('auth error', '請填寫安全信箱以保障帳戶安全！');
      
      const existingUser = await User.findOne({ username });
      if (existingUser) return socket.emit('auth error', '代號已被搶占！');
      
      const salt = bcrypt.genSaltSync(10);
      const hashedPassword = bcrypt.hashSync(password, salt);
      
      const newUser = new User({ 
        username, email, password: hashedPassword, 
        groups: [{ groupId: 'General', groupName: '大廳' }] 
      });
      await newUser.save();
      socket.emit('auth success', '身份驗證建立成功，請登入節點。');
    } catch (err) { socket.emit('auth error', '註冊時發生錯誤'); }
  });

  socket.on('login', async ({ username, password }) => {
    try {
      const user = await User.findOne({ username });
      if (!user) return socket.emit('auth error', '該特工不存在！');
      if (user.isBanned) return socket.emit('auth error', '🚫 警告：帳戶已被強制封禁！');

      const isMatch = bcrypt.compareSync(password, user.password);
      if (!isMatch) return socket.emit('auth error', '存取金鑰不符合！');
      
      onlineUsers.set(socket.id, user.username);
      socket.username = user.username; 
      broadcastOnlineStatus(); 

      socket.emit('login success', { username: user.username, friends: user.friends, groups: user.groups, role: user.role, avatar: user.avatar });
    } catch (err) { console.error('登入錯誤:', err); }
  });

  // 忘記密碼：請求驗證碼
  socket.on('request password reset', async ({ username, email }) => {
    try {
      const user = await User.findOne({ username, email });
      if (!user) return socket.emit('auth error', '使用者名稱與信箱不匹配或不存在！');
      
      // 產生 6 位隨機數字
      const code = Math.floor(100000 + Math.random() * 900000).toString();
      user.resetCode = code;
      user.resetCodeExpiry = Date.now() + 15 * 60 * 1000; // 15 分鐘有效期
      await user.save();

      // 在真實環境應呼叫 SMTP 發信。此處為展示，直接將驗證碼回傳給前端 Toast。
      socket.emit('system message', `【系統模擬郵件】已發送驗證碼至 ${email}`);
      socket.emit('reset code received', code); // 僅供展示與測試，真實環境絕對不該傳回前端
    } catch (err) { socket.emit('auth error', '系統錯誤'); }
  });

  // 忘記密碼：執行重設
  socket.on('execute password reset', async ({ username, code, newPassword }) => {
    try {
      const user = await User.findOne({ username, resetCode: code });
      if (!user) return socket.emit('auth error', '驗證碼錯誤或失效！');
      if (user.resetCodeExpiry < Date.now()) return socket.emit('auth error', '驗證碼已過期，請重新獲取！');

      const salt = bcrypt.genSaltSync(10);
      user.password = bcrypt.hashSync(newPassword, salt);
      user.resetCode = ''; // 清空
      await user.save();
      socket.emit('auth success', '金鑰重設成功，請使用新金鑰登入！');
    } catch (err) { socket.emit('auth error', '系統錯誤'); }
  });

  socket.on('disconnect', () => {
    if (onlineUsers.has(socket.id)) {
      onlineUsers.delete(socket.id);
      broadcastOnlineStatus(); 
    }
  });

  // --------------------------------------------------------
  // B. 個人檔案與資料匯出 (Profile & GDPR)
  // --------------------------------------------------------
  socket.on('fetch profile', async ({ targetUser }) => {
    try {
      const user = await User.findOne({ username: targetUser }, { password: 0, resetCode: 0 });
      if (!user) return socket.emit('system message', '找不到該特工檔案');
      
      const isOnline = Array.from(onlineUsers.values()).includes(targetUser);
      socket.emit('profile data loaded', { 
        username: user.username, email: user.email, avatar: user.avatar, bio: user.bio, role: user.role, isOnline 
      });
    } catch (e) {}
  });

  socket.on('update profile', async ({ username, bio, avatar }) => {
    try {
      const updates = {};
      if(bio !== undefined) updates.bio = bio;
      if(avatar !== undefined) updates.avatar = avatar;
      await User.updateOne({ username }, updates);
      socket.emit('system message', '個人檔案已更新！');
      // 通知自己重新拉取資料刷新介面
      socket.emit('profile updated');
    } catch (e) { socket.emit('system message', '檔案更新失敗'); }
  });

  socket.on('download account data', async ({ username }) => {
    try {
      const user = await User.findOne({ username }, { password: 0 });
      // 獲取該使用者發送過的所有訊息
      const messages = await Message.find({ sender: username });
      
      const exportData = {
        accountInfo: user,
        messagesHistory: messages,
        exportedAt: new Date().toISOString()
      };
      
      socket.emit('account data ready', exportData);
    } catch (e) { socket.emit('system message', '資料打包失敗'); }
  });

  // --------------------------------------------------------
  // C. 房間、好友與聊天邏輯
  // --------------------------------------------------------
  socket.on('create group', async ({ username, groupName }) => {
    try {
      const groupId = Math.floor(1000 + Math.random() * 9000).toString(); 
      await new Group({ groupId, groupName, members: [username] }).save();
      await User.updateOne({ username }, { $push: { groups: { groupId, groupName } } });
      socket.emit('system message', `群組 [${groupName}] 建立成功！代碼: ${groupId}`);
      socket.emit('update sidebar'); 
    } catch (e) {}
  });

  socket.on('join group by id', async ({ username, groupId }) => {
    try {
      const group = await Group.findOne({ groupId });
      if (!group) return socket.emit('system message', '代碼錯誤！');
      if (group.members.includes(username)) return socket.emit('system message', '您已在該群組中！');
      group.members.push(username); await group.save();
      await User.updateOne({ username }, { $push: { groups: { groupId: group.groupId, groupName: group.groupName } } });
      socket.emit('system message', `已加入群組: ${group.groupName}`);
      socket.emit('update sidebar');
    } catch (e) {}
  });

  socket.on('add friend', async ({ username, friendName }) => {
    try {
      if(username === friendName) return;
      const friend = await User.findOne({ username: friendName });
      if (!friend) return socket.emit('system message', '目標不存在！');
      const me = await User.findOne({ username });
      if (me.friends.includes(friendName)) return socket.emit('system message', '已是好友。');

      await User.updateOne({ username }, { $push: { friends: friendName } });
      await User.updateOne({ username: friendName }, { $push: { friends: username } });
      socket.emit('system message', `已與 ${friendName} 成為好友！`);
      socket.emit('update sidebar');
      const friendSocketId = getSocketIdByUsername(friendName);
      if (friendSocketId) io.to(friendSocketId).emit('update sidebar');
    } catch (e) {}
  });

  socket.on('delete friend', async ({ username, friendName }) => {
    try {
      await User.updateOne({ username }, { $pull: { friends: friendName } });
      await User.updateOne({ username: friendName }, { $pull: { friends: username } });
      socket.emit('system message', `已刪除好友 ${friendName}。`);
      socket.emit('update sidebar');
      const friendSocketId = getSocketIdByUsername(friendName);
      if (friendSocketId) io.to(friendSocketId).emit('update sidebar');
    } catch (e) {}
  });

  socket.on('leave group', async ({ username, groupId }) => {
    try {
      if (groupId === 'General') return;
      await Group.updateOne({ groupId }, { $pull: { members: username } });
      await User.updateOne({ username }, { $pull: { groups: { groupId } } });
      socket.emit('system message', `已退出群組。`);
      socket.emit('update sidebar');
    } catch (e) {}
  });

  socket.on('clear history', async (room) => {
    try { await Message.deleteMany({ room }); io.to(room).emit('history cleared'); } catch (e) {}
  });

  socket.on('join room', async (roomName) => {
    try {
      Array.from(socket.rooms).forEach(r => { if (r !== socket.id) socket.leave(r); });
      socket.join(roomName);
      const history = await Message.find({ room: roomName }).sort({ timestamp: 1 }).limit(150);
      socket.emit('load history', history);
    } catch (e) {}
  });

  socket.on('chat message', async (msgData) => {
    try {
      // 處理前端可能傳來的自訂頭像 (優化傳輸，避免每次帶長字串，此處僅簡單存儲)
      const newMessage = new Message(msgData);
      await newMessage.save();
      io.to(msgData.room).emit('chat message', msgData);
    } catch (e) {}
  });

  // --------------------------------------------------------
  // D. WebRTC 語音通話 (徹底修復漏接 Bug)
  // --------------------------------------------------------
  // 【核心修復】：不再依賴 socket.username，由前端強制攜帶 caller 資訊
  socket.on('call request', ({ caller, target }) => {
    const targetId = getSocketIdByUsername(target);
    if (targetId) {
      io.to(targetId).emit('incoming call', { caller });
    } else {
      socket.emit('call error', '對方目前不在線上。');
    }
  });

  socket.on('call response', ({ caller, callee, accepted }) => {
    const callerId = getSocketIdByUsername(caller);
    if (callerId) {
      io.to(callerId).emit('call response', { callee, accepted });
    }
  });

  socket.on('webrtc signal', ({ sender, target, signal }) => {
    const targetId = getSocketIdByUsername(target);
    if (targetId) {
      io.to(targetId).emit('webrtc signal', { sender, signal });
    }
  });

  socket.on('end call', ({ sender, target }) => {
    const targetId = getSocketIdByUsername(target);
    if (targetId) {
      io.to(targetId).emit('call ended', { sender });
    }
  });

  // --------------------------------------------------------
  // E. 👑 上帝模式 API (Admin 專屬)
  // --------------------------------------------------------
  const checkAdmin = async (username) => { return (await User.findOne({ username }))?.role === 'admin'; };

  socket.on('admin fetch data', async (adminUser) => {
    if (!(await checkAdmin(adminUser))) return;
    const users = await User.find({}, { password: 0, resetCode: 0 }); 
    const groups = await Group.find({});
    socket.emit('admin data loaded', { users, groups });
  });

  socket.on('admin toggle ban', async ({ adminUser, targetUser, banStatus }) => {
    if (!(await checkAdmin(adminUser)) || targetUser === 'admin') return;
    await User.updateOne({ username: targetUser }, { isBanned: banStatus });
    socket.emit('system message', `已${banStatus ? '封禁' : '解封'}：${targetUser}`);
    if (banStatus) {
      const targetSocketId = getSocketIdByUsername(targetUser);
      if (targetSocketId) {
        io.to(targetSocketId).emit('auth error', '您的存取權限已被強制終止！');
        io.sockets.sockets.get(targetSocketId)?.disconnect(true);
      }
    }
  });

  socket.on('admin reset password', async ({ adminUser, targetUser, newPassword }) => {
    if (!(await checkAdmin(adminUser))) return;
    const salt = bcrypt.genSaltSync(10);
    const hashedPassword = bcrypt.hashSync(newPassword, salt);
    await User.updateOne({ username: targetUser }, { password: hashedPassword });
    socket.emit('system message', `已強制修改 ${targetUser} 的金鑰！`);
  });

  socket.on('admin fetch room history', async ({ adminUser, roomId }) => {
    if (!(await checkAdmin(adminUser))) return;
    const history = await Message.find({ room: roomId }).sort({ timestamp: 1 }).limit(200);
    socket.emit('admin room history loaded', history);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => { console.log(`🚀 JR Chat 伺服器已啟動於 ${PORT}`); });
