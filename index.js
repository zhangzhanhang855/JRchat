const express = require('express');
const app = express();
const http = require('http');
const server = http.createServer(app);
const { Server } = require("socket.io");

// 配置 Socket.IO，允许最大 5MB 的传输（主要为了支持 Base64 图片上传）
const io = new Server(server, { 
  maxHttpBufferSize: 5e6,
  cors: { origin: "*" }
}); 

const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

// ==========================================================================
// 1. MongoDB 数据库连接与初始化
// ==========================================================================
const mongoURI = process.env.MONGODB_URI;

mongoose.connect(mongoURI, { useNewUrlParser: true, useUnifiedTopology: true })
  .then(async () => {
    console.log('✅ MongoDB 数据库连接成功');
    
    // 【系统初始化】：自动生成超级管理员 (admin) 账号
    try {
      const adminExists = await User.findOne({ username: 'admin' });
      if (!adminExists) {
        const salt = bcrypt.genSaltSync(10);
        const hashedPassword = bcrypt.hashSync('admin', salt);
        await new User({ 
          username: 'admin', 
          password: hashedPassword, 
          role: 'admin',
          groups: [{ groupId: 'General', groupName: '大厅' }]
        }).save();
        console.log('👑 超级管理员 admin 账号初始化完成');
      }
    } catch (e) {
      console.error('管理员账号检查/创建失败:', e);
    }
  })
  .catch(err => console.error('❌ MongoDB 数据库连接失败:', err));

// ==========================================================================
// 2. 数据库模型 (Schemas)
// ==========================================================================

// 用户表 (User)
const userSchema = new mongoose.Schema({
  username: { type: String, unique: true, required: true },
  password: { type: String, required: true },
  friends: [String], // 存储好友的用户名列表
  groups: [{ groupId: String, groupName: String }], // 存储加入的群聊列表
  role: { type: String, default: 'user' }, // 权限角色：'user' 或 'admin'
  isBanned: { type: Boolean, default: false } // 是否被封禁
});
const User = mongoose.model('User', userSchema);

// 群组表 (Group)
const groupSchema = new mongoose.Schema({
  groupId: { type: String, unique: true }, // 系统生成的 4 位唯一群号
  groupName: String,
  members: [String] // 群成员的用户名列表
});
const Group = mongoose.model('Group', groupSchema);

// 消息记录表 (Message)
const messageSchema = new mongoose.Schema({
  room: String, // 房间号 (群号 或 DM_A_B)
  sender: String,
  text: String, // 文本内容或 Base64 图片数据
  msgType: { type: String, default: 'text' }, // 'text' 或 'image'
  timestamp: { type: Date, default: Date.now }
});
const Message = mongoose.model('Message', messageSchema);

// ==========================================================================
// 3. 内存状态追踪 (在线人员列表)
// ==========================================================================
// 记录 socket.id 对应的 username
const onlineUsers = new Map(); 

// 静态文件路由：将前端页面发送给客户端
app.get('/', (req, res) => { 
  res.sendFile(__dirname + '/index.html'); 
});

// ==========================================================================
// 4. WebSocket 核心业务逻辑
// ==========================================================================
io.on('connection', (socket) => {
  
  // 辅助函数：广播当前在线的全局用户名单
  const broadcastOnlineStatus = () => {
    const activeUsernames = Array.from(new Set(onlineUsers.values()));
    io.emit('online status update', activeUsernames);
  };

  // --------------------------------------------------------
  // A. 鉴权系统 (注册、登录与状态保持)
  // --------------------------------------------------------
  socket.on('register', async ({ username, password }) => {
    try {
      if (username.toLowerCase() === 'admin') return socket.emit('auth error', 'Admin 是系统保留账户，无法注册！');
      
      const existingUser = await User.findOne({ username });
      if (existingUser) return socket.emit('auth error', '用户名已被抢占，换一个吧！');
      
      const salt = bcrypt.genSaltSync(10);
      const hashedPassword = bcrypt.hashSync(password, salt);
      
      const newUser = new User({ 
        username, 
        password: hashedPassword, 
        groups: [{ groupId: 'General', groupName: '大厅' }] // 新用户默认加入大厅
      });
      await newUser.save();
      
      socket.emit('auth success', '身份验证创建成功，请登录节点。');
    } catch (err) { 
      console.error('注册错误:', err); 
      socket.emit('auth error', '注册时发生服务器错误');
    }
  });

  socket.on('login', async ({ username, password }) => {
    try {
      const user = await User.findOne({ username });
      if (!user) return socket.emit('auth error', '该用户节点不存在！');
      
      // 封禁拦截逻辑
      if (user.isBanned) return socket.emit('auth error', '🚫 警告：该账户已被系统强制封禁访问权限！');

      const isMatch = bcrypt.compareSync(password, user.password);
      if (!isMatch) return socket.emit('auth error', '访问密钥不匹配！');
      
      // 登录成功，更新在线追踪器
      onlineUsers.set(socket.id, user.username);
      socket.username = user.username; 
      broadcastOnlineStatus(); // 通知所有人该用户上线了

      socket.emit('login success', { 
        username: user.username, 
        friends: user.friends, 
        groups: user.groups, 
        role: user.role 
      });
    } catch (err) { 
      console.error('登录错误:', err); 
    }
  });

  socket.on('disconnect', () => {
    if (onlineUsers.has(socket.id)) {
      onlineUsers.delete(socket.id);
      broadcastOnlineStatus(); // 通知所有人该用户下线了
    }
  });

  // --------------------------------------------------------
  // B. 房间与好友关系管理
  // --------------------------------------------------------
  
  // 创建新群聊
  socket.on('create group', async ({ username, groupName }) => {
    try {
      // 随机生成 4 位群号
      const groupId = Math.floor(1000 + Math.random() * 9000).toString(); 
      await new Group({ groupId, groupName, members: [username] }).save();
      
      await User.updateOne({ username }, { $push: { groups: { groupId, groupName } } });
      
      socket.emit('system message', `群聊 [${groupName}] 节点创建成功！网络识别码: ${groupId}`);
      socket.emit('update sidebar'); // 通知前端重新拉取侧边栏数据
    } catch (e) { console.error(e); }
  });

  // 通过群号加入群聊
  socket.on('join group by id', async ({ username, groupId }) => {
    try {
      const group = await Group.findOne({ groupId });
      if (!group) return socket.emit('system message', '未找到对应的网络识别码！');
      if (group.members.includes(username)) return socket.emit('system message', '您已在该节点的通讯网络中！');
      
      group.members.push(username);
      await group.save();
      
      await User.updateOne({ username }, { $push: { groups: { groupId: group.groupId, groupName: group.groupName } } });
      
      socket.emit('system message', `已成功接入节点: ${group.groupName}`);
      socket.emit('update sidebar');
    } catch (e) { console.error(e); }
  });

  // 添加好友
  socket.on('add friend', async ({ username, friendName }) => {
    try {
      if(username === friendName) return socket.emit('system message', '无法与自己建立链接。');
      
      const friend = await User.findOne({ username: friendName });
      if (!friend) return socket.emit('system message', '目标特工代号不存在！');
      
      const me = await User.findOne({ username });
      if (me.friends.includes(friendName)) return socket.emit('system message', '加密通讯链路已存在。');

      // 互相添加进对方的 friends 数组
      await User.updateOne({ username }, { $push: { friends: friendName } });
      await User.updateOne({ username: friendName }, { $push: { friends: username } });
      
      socket.emit('system message', `已成功与 ${friendName} 建立私人连接！`);
      socket.emit('update sidebar');
      
      // 如果对方当前在线，强制刷新他的侧边栏，让他立刻看到你
      const friendSocketId = [...onlineUsers.entries()].find(([k, v]) => v === friendName)?.[0];
      if (friendSocketId) io.to(friendSocketId).emit('update sidebar');
    } catch (e) { console.error(e); }
  });

  // 删除好友 (毁灭操作)
  socket.on('delete friend', async ({ username, friendName }) => {
    try {
      await User.updateOne({ username }, { $pull: { friends: friendName } });
      await User.updateOne({ username: friendName }, { $pull: { friends: username } });
      socket.emit('system message', `已销毁与 ${friendName} 的链接协议。`);
      socket.emit('update sidebar');
      
      // 同样通知对方刷新
      const friendSocketId = [...onlineUsers.entries()].find(([k, v]) => v === friendName)?.[0];
      if (friendSocketId) io.to(friendSocketId).emit('update sidebar');
    } catch (e) { console.error(e); }
  });

  // 退出群聊
  socket.on('leave group', async ({ username, groupId }) => {
    try {
      if (groupId === 'General') return socket.emit('system message', '大厅节点为全局广播通道，无法断开！');
      
      await Group.updateOne({ groupId }, { $pull: { members: username } });
      await User.updateOne({ username }, { $pull: { groups: { groupId } } });
      
      socket.emit('system message', `已切断与该群组的网络连接。`);
      socket.emit('update sidebar');
    } catch (e) { console.error(e); }
  });

  // 清空房间记录 (核弹操作)
  socket.on('clear history', async (room) => {
    try {
      await Message.deleteMany({ room });
      // 广播给房间里所有人：该房间的记录已被核平
      io.to(room).emit('history cleared'); 
    } catch (e) { console.error(e); }
  });

  // --------------------------------------------------------
  // C. 核心聊天引擎
  // --------------------------------------------------------
  
  // 加入特定 Socket.IO 房间以接收广播
  socket.on('join room', async (roomName) => {
    try {
      // 退出除了自身 ID 以外的所有房间
      Array.from(socket.rooms).forEach(r => { if (r !== socket.id) socket.leave(r); });
      
      socket.join(roomName);
      
      // 从数据库抓取该房间的最近 150 条记录
      const history = await Message.find({ room: roomName }).sort({ timestamp: 1 }).limit(150);
      socket.emit('load history', history);
    } catch (e) { console.error(e); }
  });

  // 接收并处理新消息 (支持文本与 Base64 图片)
  socket.on('chat message', async (msgData) => {
    try {
      // 1. 存入数据库
      const newMessage = new Message(msgData);
      await newMessage.save();
      
      // 2. 广播给该房间内的所有活跃连接
      io.to(msgData.room).emit('chat message', msgData);
    } catch (e) { console.error('保存消息失败:', e); }
  });

  // --------------------------------------------------------
  // D. 👑 上帝模式 API (Admin 专属)
  // --------------------------------------------------------
  
  // 权限校验中间件
  const checkAdmin = async (username) => {
    const user = await User.findOne({ username });
    return user && user.role === 'admin';
  };

  // 抓取全站数据面板
  socket.on('admin fetch data', async (adminUser) => {
    if (!(await checkAdmin(adminUser))) return;
    
    // 隐藏 password 字段，防止密码哈希泄露给前端
    const users = await User.find({}, { password: 0 }); 
    const groups = await Group.find({});
    
    socket.emit('admin data loaded', { users, groups });
  });

  // 封禁/解封 任意用户
  socket.on('admin toggle ban', async ({ adminUser, targetUser, banStatus }) => {
    if (!(await checkAdmin(adminUser)) || targetUser === 'admin') return;
    
    await User.updateOne({ username: targetUser }, { isBanned: banStatus });
    socket.emit('system message', `已${banStatus ? '封禁' : '解封'}特工：${targetUser}`);
    
    // 如果是执行封禁，且该用户在线，触发强制踢下线机制
    if (banStatus) {
      const targetSocketId = [...onlineUsers.entries()].find(([k, v]) => v === targetUser)?.[0];
      if (targetSocketId) {
        io.to(targetSocketId).emit('auth error', '【系统警告】您的访问权限已被根节点服务器强行终止！');
        io.sockets.sockets.get(targetSocketId)?.disconnect(true);
      }
    }
  });

  // 强制重置任意用户密码
  socket.on('admin reset password', async ({ adminUser, targetUser, newPassword }) => {
    if (!(await checkAdmin(adminUser))) return;
    
    const salt = bcrypt.genSaltSync(10);
    const hashedPassword = bcrypt.hashSync(newPassword, salt);
    
    await User.updateOne({ username: targetUser }, { password: hashedPassword });
    socket.emit('system message', `已强制覆写 ${targetUser} 的访问密钥！`);
  });

  // 幽灵协议：无需加入房间，直接调阅数据库历史
  socket.on('admin fetch room history', async ({ adminUser, roomId }) => {
    if (!(await checkAdmin(adminUser))) return;
    
    const history = await Message.find({ room: roomId }).sort({ timestamp: 1 }).limit(200);
    socket.emit('admin room history loaded', history);
  });
});

// ==========================================================================
// 5. 启动服务器监听
// ==========================================================================
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => { 
  console.log(`🚀 JR Chat 服务器引擎已在端口 ${PORT} 点火运行`); 
});
