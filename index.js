const express = require('express');
const app = express();
const http = require('http');
const server = http.createServer(app);
const { Server } = require("socket.io");
const io = new Server(server, { maxHttpBufferSize: 5e6 }); // 允许最大 5MB 的数据传输（为图片准备）
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const mongoURI = process.env.MONGODB_URI;
mongoose.connect(mongoURI, { useNewUrlParser: true, useUnifiedTopology: true })
  .then(() => console.log('✅ 数据库连接成功'))
  .catch(err => console.error('❌ 数据库连接失败:', err));

// --- 数据库模型 ---
const userSchema = new mongoose.Schema({
  username: { type: String, unique: true, required: true },
  password: { type: String, required: true },
  friends: [String],
  groups: [{ groupId: String, groupName: String }]
});
const User = mongoose.model('User', userSchema);

const groupSchema = new mongoose.Schema({
  groupId: { type: String, unique: true },
  groupName: String,
  members: [String]
});
const Group = mongoose.model('Group', groupSchema);

// 【升级】：加入 msgType 字段，用来区分是文字还是图片
const messageSchema = new mongoose.Schema({
  room: String,
  sender: String,
  text: String, // 如果是图片，这里存的就是 Base64 字符串
  msgType: { type: String, default: 'text' }, // 'text' 或 'image'
  timestamp: { type: Date, default: Date.now }
});
const Message = mongoose.model('Message', messageSchema);

app.get('/', (req, res) => { res.sendFile(__dirname + '/index.html'); });

io.on('connection', (socket) => {
  // 1. 注册
  socket.on('register', async ({ username, password }) => {
    try {
      const existingUser = await User.findOne({ username });
      if (existingUser) return socket.emit('auth error', '用户名已被抢占！');
      const salt = bcrypt.genSaltSync(10);
      const hashedPassword = bcrypt.hashSync(password, salt);
      const newUser = new User({ username, password: hashedPassword, groups: [{ groupId: 'General', groupName: '大厅' }] });
      await newUser.save();
      socket.emit('auth success', '注册成功，请登录！');
    } catch (err) { console.error(err); }
  });

  // 2. 登录
  socket.on('login', async ({ username, password }) => {
    try {
      const user = await User.findOne({ username });
      if (!user) return socket.emit('auth error', '用户不存在！');
      const isMatch = bcrypt.compareSync(password, user.password);
      if (!isMatch) return socket.emit('auth error', '密码错误！');
      socket.emit('login success', { username: user.username, friends: user.friends, groups: user.groups });
    } catch (err) { console.error(err); }
  });

  // 3. 建群 / 加群 / 加好友
  socket.on('create group', async ({ username, groupName }) => {
    const groupId = Math.floor(1000 + Math.random() * 9000).toString(); 
    const newGroup = new Group({ groupId, groupName, members: [username] });
    await newGroup.save();
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
  });

  // 【新增】：删除好友
  socket.on('delete friend', async ({ username, friendName }) => {
    await User.updateOne({ username }, { $pull: { friends: friendName } });
    await User.updateOne({ username: friendName }, { $pull: { friends: username } });
    socket.emit('system message', `已删除好友: ${friendName}`);
    socket.emit('update sidebar');
  });

  // 【新增】：退出群聊
  socket.on('leave group', async ({ username, groupId }) => {
    if (groupId === 'General') return socket.emit('system message', '大厅是无法退出的哦！');
    await Group.updateOne({ groupId }, { $pull: { members: username } });
    await User.updateOne({ username }, { $pull: { groups: { groupId } } });
    socket.emit('system message', `已退出群聊`);
    socket.emit('update sidebar');
  });

  // 【新增】：清空房间聊天记录
  socket.on('clear history', async (room) => {
    await Message.deleteMany({ room });
    io.to(room).emit('history cleared'); // 广播给房间里所有人：记录已清空
  });

  // 4. 收发消息（支持文字和图片）
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
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => { console.log(`Server running on port ${PORT}`); });
