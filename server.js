//
// server.js
// ─────────────────────────────────────────────────────────────────────────────
// Auction Room Server (v2.5 – supports “Elimination Auction” plus icon/display paths):
//   • Normal auction = pull from room.auctionOrder
//   • Elimination auction = pull from room.elimination
//   • New events: start_elim_auction, elim_timer_tick, etc.
//   • Avatar icons come from /img/icons/{username}.png
//   • Display images come from /img/display/{playerName}.png
// ─────────────────────────────────────────────────────────────────────────────

const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server);

const PORT = process.env.PORT || 3000;

// Serve static files from /public
app.use(express.static('public'));

// In‑memory rooms storage
//
// rooms[roomCode] = {
//   settings: { maxCaptains, initialPoints, playersPerTeam, limitByTier, allowedTiers },
//   teams: {
//     "Team 1": { captainName: String|null, points: Number, members: [ {username, tier} ] },
//     …
//   },
//   auctionOrder:    [ { username, tier }, … ],
//   elimination:     [ { username, tier }, … ],
//   finalEliminated: [ { username, tier }, … ],  // those who failed twice
//   chatLog:         [ { username, text, timestamp }, … ],
//   spectators:      [ String, … ],
//
//   // currentAuction is used for both normal & elimination auctions. We add a flag isElimination.
//   currentAuction: {
//     playerName:   String,
//     tier:         String,
//     highestBid:   Number,
//     highestBidder:String|null,
//     isElimination: Boolean
//   } or null,
//
//   timerObj: {           // shared for both auction types
//     remainingMs: Number,
//     paused:      Boolean,
//     intervalId:  NodeJS.Timer
//   } or null
// }
const rooms = {};


// ─────────── CREATE NEW AUCTION ROOM ───────────
// Endpoint: GET /create_room?maxCaptains=2&initialPoints=1000&playersPerTeam=4&limitByTier=true
// Response: { roomCode, maxCaptains, initialPoints, playersPerTeam, limitByTier }
// ─────────────────────────────────────────────────────────────
app.get('/create_room', (req, res) => {
  const maxCaptains    = parseInt(req.query.maxCaptains, 10);
  const initialPoints  = parseInt(req.query.initialPoints, 10);
  const playersPerTeam = parseInt(req.query.playersPerTeam, 10);
  const limitByTier    = req.query.limitByTier === 'true';

  if (
    isNaN(maxCaptains) ||
    isNaN(initialPoints) ||
    isNaN(playersPerTeam) ||
    maxCaptains < 1 ||
    initialPoints < 0 ||
    (playersPerTeam !== 4 && playersPerTeam !== 5)
  ) {
    return res.status(400).json({ error: 'Invalid parameters.' });
  }

  // allowedTiers = ['A','B','C','D'] or ['A','B','C','D','E']
  const allTiers     = ['A','B','C','D','E'];
  const allowedTiers = allTiers.slice(0, playersPerTeam);

  // Generate a unique room code
  let roomCode;
  do {
    roomCode = Math.random().toString(36).substr(2, 6).toUpperCase();
  } while (rooms[roomCode]);

  // Initialize teams
  const teams = {};
  for (let i = 1; i <= maxCaptains; i++) {
    teams[`Team ${i}`] = {
      captainName: null,
      points:      initialPoints,
      members:     []
    };
  }

  rooms[roomCode] = {
    settings: {
      maxCaptains,
      initialPoints,
      playersPerTeam,
      limitByTier,
      allowedTiers
    },
    teams,
    auctionOrder:    [],
    elimination:     [],
    finalEliminated: [],
    chatLog:         [],
    spectators:      [],
    currentAuction:  null,
    timerObj:        null
  };

  return res.json({
    roomCode,
    maxCaptains,
    initialPoints,
    playersPerTeam,
    limitByTier
  });
});


// ───────── SOCKET.IO HANDLERS ─────────
io.on('connection', (socket) => {
  console.log(`소켓 연결됨: ${socket.id}`);

  // ── Helper: broadcast full room state, including elimination/finalEliminated
  function broadcastRoomState(roomCode) {
    const room = rooms[roomCode];
    if (!room) return;

    // Build a “players” array from teams, auctionOrder, elimination, and finalEliminated
    const playersArr = [];
    for (const [teamName, tObj] of Object.entries(room.teams)) {
      if (tObj.captainName) {
        playersArr.push({
          username:  tObj.captainName,
          teamName,
          balance:   tObj.points,
          isCaptain: true
        });
      }
      for (const m of tObj.members) {
        playersArr.push({
          username:  m.username,
          teamName,
          balance:   tObj.points,
          isCaptain: false,
          tier:      m.tier
        });
      }
    }
    for (const entry of room.auctionOrder) {
      playersArr.push({
        username:  entry.username,
        teamName:  null,
        balance:   room.settings.initialPoints,
        isCaptain: false,
        tier:      entry.tier
      });
    }
    for (const entry of room.elimination) {
      playersArr.push({
        username:  entry.username,
        teamName:  null,
        balance:   room.settings.initialPoints,
        isCaptain: false,
        tier:      entry.tier
      });
    }
    for (const entry of room.finalEliminated) {
      playersArr.push({
        username:  entry.username,
        teamName:  null,
        balance:   0,
        isCaptain: false,
        tier:      entry.tier,
        finalElim: true
      });
    }

    io.in(roomCode).emit('room_update', {
      settings:       room.settings,
      teams:          room.teams,
      auctionOrder:   room.auctionOrder,
      elimination:    room.elimination,
      finalEliminated:room.finalEliminated,
      chatLog:        room.chatLog,
      currentAuction: room.currentAuction,
      players:        playersArr
    });
  }

  // ── PLAYER JOINS ROOM ──
  socket.on('join_room', ({ roomCode, username, asCaptain, tier }) => {
    const room = rooms[roomCode];
    if (!room) {
      socket.emit('error_message', '유효하지 않은 방 코드입니다.');
      return;
    }

    // Prevent duplicate usernames
    const existing = new Set();
    for (const tObj of Object.values(room.teams)) {
      if (tObj.captainName) existing.add(tObj.captainName);
      for (const m of tObj.members) existing.add(m.username);
    }
    for (const e of room.auctionOrder)     existing.add(e.username);
    for (const e of room.elimination)      existing.add(e.username);
    for (const e of room.finalEliminated)  existing.add(e.username);
    for (const s of room.spectators)       existing.add(s);

    if (existing.has(username)) {
      socket.emit('error_message', '이미 사용 중인 닉네임입니다.');
      return;
    }

    // When admin joins as captain (modify join_room handler)
    if (asCaptain) {
      // assign to first empty captain slot
      let assigned = false;
      for (const [teamName, tObj] of Object.entries(room.teams)) {
        if (!tObj.captainName) {
          tObj.captainName = username;
          assigned = true;
          // If this is the first captain, treat as admin
          if (!room.adminSocketId) room.adminSocketId = socket.id;
          break;
        }
      }
      if (!assigned) {
        socket.emit('error_message', '모든 주장 슬롯이 이미 찼습니다.');
        return;
      }
    } else {
      // not a captain
      if (typeof tier === 'string' && room.settings.allowedTiers.includes(tier)) {
        room.auctionOrder.push({ username, tier });
      } else {
        room.spectators.push(username);
      }
    }

    socket.join(roomCode);

    // Announce join in chat
    const joinMsg = asCaptain
    ? `${username}님이 주장으로 참가했습니다.`
    : `${username}님이 ${tier ? `티어 ${tier} 입찰자로` : '관전자'}로 참가했습니다.`;  
    const joinEntry = { username: 'SYSTEM', text: joinMsg, timestamp: Date.now() };
    room.chatLog.push(joinEntry);
    io.in(roomCode).emit('chat_update', joinEntry);

    broadcastRoomState(roomCode);
  });

  // ── HOST REJOIN ──
  socket.on('host_join', ({ roomCode }) => {
    const room = rooms[roomCode];
    if (!room) {
      socket.emit('error_message', '잘못된 방 코드입니다.');
      return;
    }
    socket.join(roomCode);

    const playersArr = [];
    for (const [teamName, tObj] of Object.entries(room.teams)) {
      if (tObj.captainName) {
        playersArr.push({
          username:  tObj.captainName,
          teamName,
          balance:   tObj.points,
          isCaptain: true
        });
      }
      for (const m of tObj.members) {
        playersArr.push({
          username:  m.username,
          teamName,
          balance:   tObj.points,
          isCaptain: false,
          tier:      m.tier
        });
      }
    }
    for (const entry of room.auctionOrder) {
      playersArr.push({
        username:  entry.username,
        teamName:  null,
        balance:   room.settings.initialPoints,
        isCaptain: false,
        tier:      entry.tier
      });
    }
    for (const entry of room.elimination) {
      playersArr.push({
        username:  entry.username,
        teamName:  null,
        balance:   room.settings.initialPoints,
        isCaptain: false,
        tier:      entry.tier
      });
    }
    for (const entry of room.finalEliminated) {
      playersArr.push({
        username:  entry.username,
        teamName:  null,
        balance:   0,
        isCaptain: false,
        tier:      entry.tier,
        finalElim: true
      });
    }

    socket.emit('rejoin_success', {
      settings:        room.settings,
      teams:           room.teams,
      auctionOrder:    room.auctionOrder,
      elimination:     room.elimination,
      finalEliminated: room.finalEliminated,
      chatLog:         room.chatLog,
      currentAuction:  room.currentAuction,
      players:         playersArr
    });
  });

  // ── CHAT MESSAGE ──
  socket.on('send_chat', ({ roomCode, username, text }) => {
    const room = rooms[roomCode];
    if (!room) {
      socket.emit('error_message', '채팅을 보낼 수 없습니다: 잘못된 방입니다.');
      return;
    }
    const entry = { username, text, timestamp: Date.now() };
    room.chatLog.push(entry);
    io.in(roomCode).emit('chat_update', entry);
  });

  // ── SYSTEM ANNOUNCE (helper) ──
  socket.on('system_announce', ({ roomCode, text }) => {
    const room = rooms[roomCode];
    if (!room) return;
    const entry = { username: 'SYSTEM', text, timestamp: Date.now() };
    room.chatLog.push(entry);
    io.in(roomCode).emit('chat_update', entry);
  });

  // ── SHUFFLE AUCTION ORDER (ADMIN) ──
  socket.on('shuffle_auction', ({ roomCode }) => {
    const room = rooms[roomCode];
    if (!room) return;

    // Fisher–Yates shuffle
    for (let i = room.auctionOrder.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [room.auctionOrder[i], room.auctionOrder[j]] = [room.auctionOrder[j], room.auctionOrder[i]];
    }
    const msg = '관리자가 경매 순서를 섞었습니다.';
    const entry = { username: 'SYSTEM', text: msg, timestamp: Date.now() };
    room.chatLog.push(entry);
    io.in(roomCode).emit('chat_update', entry);

    broadcastRoomState(roomCode);
  });

  // ── SEED AUCTION ORDER (RANDOM or URL) ──
  socket.on('seed_auction', ({ roomCode, entries }) => {
    const room = rooms[roomCode];
    if (!room) return;
    room.auctionOrder = [];
    for (const e of entries) {
      if (
        typeof e.username === 'string' &&
        typeof e.tier === 'string' &&
        room.settings.allowedTiers.includes(e.tier)
      ) {
        room.auctionOrder.push({ username: e.username.trim(), tier: e.tier.trim().toUpperCase() });
      }
    }
    const seedMsg = '관리자가 경매 순서를 설정했습니다.';
    const seedEntry = { username: 'SYSTEM', text: seedMsg, timestamp: Date.now() };
    room.chatLog.push(seedEntry);
    io.in(roomCode).emit('chat_update', seedEntry);

    broadcastRoomState(roomCode);
  });


  //
  // ────────────────────────────────────────────────────────────────────────────
  //   AUCTION LIFECYCLE: start_auction / pause_auction / resume_auction
  //   (normal players in auctionOrder)
  // ────────────────────────────────────────────────────────────────────────────
  //

  function clearAuctionTimer(roomCode) {
    const room = rooms[roomCode];
    if (!room || !room.timerObj) return;
    clearInterval(room.timerObj.intervalId);
    room.timerObj = null;
  }

  socket.on('start_auction', ({ roomCode }) => {
    const room = rooms[roomCode];
    if (!room) {
      socket.emit('error_message', '채팅을 보낼 수 없습니다: 잘못된 방입니다.');
      return;
    }
    if (room.auctionOrder.length === 0) {
      socket.emit('error_message', '경매에 남은 플레이어가 없습니다.');
      return;
    }

    // If an auction is already in progress, clear it first
    if (room.timerObj) {
      clearAuctionTimer(roomCode);
    }

    // Peek at the next player (index 0) from auctionOrder
    const next = room.auctionOrder[0];
    room.currentAuction = {
      playerName:    next.username,
      tier:          next.tier,
      highestBid:    0,
      highestBidder: null,
      isElimination: false
    };

    // Announce in chat
    const startMsg = `경매: ${next.username} (티어 ${next.tier}) 경매가 시작되었습니다!`;
    const startEntry = { username: 'SYSTEM', text: startMsg, timestamp: Date.now() };
    room.chatLog.push(startEntry);
    io.in(roomCode).emit('chat_update', startEntry);

    // 15 second countdown
    room.timerObj = {
      remainingMs: 15_000,
      paused:      false,
      intervalId:  null
    };

    io.in(roomCode).emit('auction_started', { timer: 15 });

    room.timerObj.intervalId = setInterval(() => {
      if (!room.timerObj || room.timerObj.paused) return;
      room.timerObj.remainingMs -= 1000;
      const secsLeft = Math.ceil(room.timerObj.remainingMs / 1000);
      if (room.timerObj.remainingMs <= 0) {
        clearInterval(room.timerObj.intervalId);
        room.timerObj = null;
        handleAuctionExpiration(roomCode, false); // false = not elimination
        return;
      }
      io.in(roomCode).emit('timer_tick', secsLeft);
    }, 1000);

    broadcastRoomState(roomCode);
  });

  socket.on('pause_auction', ({ roomCode }) => {
    const room = rooms[roomCode];
    if (!room || !room.timerObj) {
      socket.emit('error_message', '진행 중인 경매가 없어 일시정지할 수 없습니다.');
      return;
    }
    room.timerObj.paused = true;
    clearInterval(room.timerObj.intervalId);

    const entry = { username: 'SYSTEM', text: 'Auction paused.', timestamp: Date.now() };
    room.chatLog.push(entry);
    io.in(roomCode).emit('chat_update', entry);

    io.in(roomCode).emit('auction_paused');
  });

  socket.on('resume_auction', ({ roomCode }) => {
    const room = rooms[roomCode];
    if (!room || !room.timerObj || !room.timerObj.paused) {
      socket.emit('error_message', '일시정지된 경매가 없어 다시 시작할 수 없습니다.');
      return;
    }
    room.timerObj.paused = false;
    const secsLeft = Math.ceil(room.timerObj.remainingMs / 1000);

    const entry = { username: 'SYSTEM', text: 'Auction resumed.', timestamp: Date.now() };
    room.chatLog.push(entry);
    io.in(roomCode).emit('chat_update', entry);

    io.in(roomCode).emit('auction_resumed', { timer: secsLeft });

    room.timerObj.intervalId = setInterval(() => {
      if (!room.timerObj || room.timerObj.paused) return;
      room.timerObj.remainingMs -= 1000;
      const sLeft = Math.ceil(room.timerObj.remainingMs / 1000);
      if (room.timerObj.remainingMs <= 0) {
        clearInterval(room.timerObj.intervalId);
        room.timerObj = null;
        handleAuctionExpiration(roomCode, false);
        return;
      }
      io.in(roomCode).emit('timer_tick', sLeft);
    }, 1000);
  });

  socket.on('place_bid', ({ roomCode, captainName, amount }) => {
    const room = rooms[roomCode];
    if (!room || !room.currentAuction) {
      socket.emit('bid_error', '입찰할 수 있는 진행 중인 경매가 없습니다.');
      return;
    }
  
    // Determine which pool we’re bidding on:
    const isElim = room.currentAuction.isElimination;
  
    // Determine the team of the bidding captain
    let captainTeamName = null;
    for (const [tName, tObj] of Object.entries(room.teams)) {
      if (tObj.captainName === captainName) {
        captainTeamName = tName;
        break;
      }
    }
    if (!captainTeamName) {
      socket.emit('bid_error', '이 방에서 캡틴으로 인식되지 않습니다.');
      return;
    }
  
    // Prevent duplicate tier in team (if enabled)
    if (room.settings.limitByTier) {
      const auctionTier = room.currentAuction.tier;
      const teamObj = room.teams[captainTeamName];
      const hasTier = teamObj.members.some(m => m.tier === auctionTier);
      if (hasTier) {
        socket.emit('bid_error', `이미 ${auctionTier} 티어의 선수가 팀에 있습니다. 동일 티어 선수는 입찰할 수 없습니다.`);
        return;
      }
    }

    // Ensure new bid > current highestBid
    if (amount <= room.currentAuction.highestBid) {
      socket.emit('bid_error', `입찰 금액은 현재 최고 입찰가(${room.currentAuction.highestBid})보다 높아야 합니다.`);
      return;
    }

    // Ensure the captain has enough points
    const captainPts = room.teams[captainTeamName].points;
    if (amount > captainPts) {
      socket.emit('bid_error', `포인트가 부족합니다. 보유 포인트: ${captainPts}점`);
      return;
    }

    // Accept the bid
    room.currentAuction.highestBid    = amount;
    room.currentAuction.highestBidder = captainName;

    // Announce in chat
    const bidMsg = `${captainName}님이 ${room.currentAuction.playerName}님을 ${amount} 포인트로 입찰했습니다.`;
    const entry  = { username: 'SYSTEM', text: bidMsg, timestamp: Date.now() };
    room.chatLog.push(entry);
    io.in(roomCode).emit('chat_update', entry);

    // Notify “new_highest_bid” so clients can play the success sound
    io.in(roomCode).emit('new_highest_bid', {
      playerName:    room.currentAuction.playerName,
      highestBid:    amount,
      highestBidder: captainName
    });

    // Reset countdown to 15 s on each new bid
    if (room.timerObj) {
      clearInterval(room.timerObj.intervalId);
      room.timerObj = {
        remainingMs: 15_000,
        paused:      false,
        intervalId:  null
      };
      io.in(roomCode).emit('timer_tick', 15);
      room.timerObj.intervalId = setInterval(() => {
        if (!room.timerObj || room.timerObj.paused) return;
        room.timerObj.remainingMs -= 1000;
        const sLeft = Math.ceil(room.timerObj.remainingMs / 1000);
        if (room.timerObj.remainingMs <= 0) {
          clearInterval(room.timerObj.intervalId);
          room.timerObj = null;
          handleAuctionExpiration(roomCode, isElim);
          return;
        }
        io.in(roomCode).emit('timer_tick', sLeft);
      }, 1000);
    }
  });

  // ───────────────────────────────────────────────────────────────────────────
  //   “Start 유찰경매” – exactly like start_auction, but from room.elimination[]
  // ───────────────────────────────────────────────────────────────────────────
  socket.on('start_elim_auction', ({ roomCode }) => {
    const room = rooms[roomCode];
    if (!room) {
      socket.emit('error_message', '유찰 경매를 시작할 수 없습니다: 잘못된 방입니다.');
      return;
    }
    if (room.elimination.length === 0) {
      socket.emit('error_message', '유찰 경매에 참가할 플레이어가 없습니다.');
      return;
    }

    // If a normal or elimination auction is already in progress, clear it
    if (room.timerObj) {
      clearAuctionTimer(roomCode);
    }

    // Peek at the next player in elimination[]
    const next = room.elimination[0];
    room.currentAuction = {
      playerName:    next.username,
      tier:          next.tier,
      highestBid:    0,
      highestBidder: null,
      isElimination: true
    };

    // Announce in chat
    const startMsg = `유찰 경매: ${next.username} (티어 ${next.tier}) 경매가 시작되었습니다!`;
    const startEntry = { username: 'SYSTEM', text: startMsg, timestamp: Date.now() };
    room.chatLog.push(startEntry);
    io.in(roomCode).emit('chat_update', startEntry);

    // 15 second countdown
    room.timerObj = {
      remainingMs: 15_000,
      paused:      false,
      intervalId:  null
    };

    io.in(roomCode).emit('elim_auction_started', { timer: 15 });

    room.timerObj.intervalId = setInterval(() => {
      if (!room.timerObj || room.timerObj.paused) return;
      room.timerObj.remainingMs -= 1000;
      const secsLeft = Math.ceil(room.timerObj.remainingMs / 1000);
      if (room.timerObj.remainingMs <= 0) {
        clearInterval(room.timerObj.intervalId);
        room.timerObj = null;
        handleAuctionExpiration(roomCode, true); // true = elimination stage
        return;
      }
      io.in(roomCode).emit('elim_timer_tick', secsLeft);
    }, 1000);

    broadcastRoomState(roomCode);
  });

  socket.on('pause_elim_auction', ({ roomCode }) => {
    const room = rooms[roomCode];
    if (!room || !room.timerObj) {
      socket.emit('error_message', '유찰 경매가 진행 중이 아니어서 일시정지할 수 없습니다.');
      return;
    }
    room.timerObj.paused = true;
    clearInterval(room.timerObj.intervalId);

    const entry = { username: 'SYSTEM', text: '유찰 경매가 일시정지되었습니다.', timestamp: Date.now() };
    room.chatLog.push(entry);
    io.in(roomCode).emit('chat_update', entry);

    io.in(roomCode).emit('elim_auction_paused');
  });

  socket.on('resume_elim_auction', ({ roomCode }) => {
    const room = rooms[roomCode];
    if (!room || !room.timerObj || !room.timerObj.paused) {
      socket.emit('error_message', '일시정지된 유찰 경매가 없어 재개할 수 없습니다.');
      return;
    }
    room.timerObj.paused = false;
    const secsLeft = Math.ceil(room.timerObj.remainingMs / 1000);

    const entry = { username: 'SYSTEM', text: '유찰 경매가 재개되었습니다.', timestamp: Date.now() };
    room.chatLog.push(entry);
    io.in(roomCode).emit('chat_update', entry);

    io.in(roomCode).emit('elim_auction_resumed', { timer: secsLeft });

    room.timerObj.intervalId = setInterval(() => {
      if (!room.timerObj || room.timerObj.paused) return;
      room.timerObj.remainingMs -= 1000;
      const sLeft = Math.ceil(room.timerObj.remainingMs / 1000);
      if (room.timerObj.remainingMs <= 0) {
        clearInterval(room.timerObj.intervalId);
        room.timerObj = null;
        handleAuctionExpiration(roomCode, true);
        return;
      }
      io.in(roomCode).emit('elim_timer_tick', sLeft);
    }, 1000);
  });

  // ───────────────────────────────────────────────────────────────────────────
  //   Handle auction expiration for both normal and elimination auctions.
  //   If isElimination = false => shift from room.auctionOrder.
  //   If isElimination = true  => shift from room.elimination.
  //
  //   If sold: put player onto the winning team.
  //   If no bids: 
  //      • If first‐round (isElimination=false), move them to room.elimination.
  //      • If elimination‐round (isElimination=true), move them to room.finalEliminated.
  // ───────────────────────────────────────────────────────────────────────────
  function handleAuctionExpiration(roomCode, isElimination) {
    const room = rooms[roomCode];
    if (!room) return;
  
    const ca = room.currentAuction;
    if (!ca) return;
  
    // If isElimination (유찰 경매)
    if (isElimination) {
      // Remove the player from the front of elimination list
      room.elimination = room.elimination.filter(
        entry => entry.username !== ca.playerName
      );
  
      if (ca.highestBidder) {
        // Player was bought: assign to team (as usual)
        let winningTeamName = null;
        for (const [tName, tObj] of Object.entries(room.teams)) {
          if (tObj.captainName === ca.highestBidder) {
            winningTeamName = tName;
            break;
          }
        }
        if (winningTeamName) {
          const teamObj = room.teams[winningTeamName];
          teamObj.points -= ca.highestBid;
          teamObj.members.push({ username: ca.playerName, tier: ca.tier });
  
          const soldMsg = `${ca.playerName}님이 ${ca.highestBidder}님에게 ${ca.highestBid} 포인트에 낙찰되었습니다.`;
          const soldEntry = { username: 'SYSTEM', text: soldMsg, timestamp: Date.now() };
          room.chatLog.push(soldEntry);
          io.in(roomCode).emit('chat_update', soldEntry);
        }
      } else {
        // Player NOT bought: send to back of elimination list
        room.elimination.push({ username: ca.playerName, tier: ca.tier });
        const elimMsg = `${ca.playerName}님은 유찰되어 다음 순서로 넘어갑니다.`; // "Moved to the back of elimination queue"
        const elimEntry = { username: 'SYSTEM', text: elimMsg, timestamp: Date.now() };
        room.chatLog.push(elimEntry);
        io.in(roomCode).emit('chat_update', elimEntry);
      }
  
      // Clear currentAuction
      room.currentAuction = null;
  
      broadcastRoomState(roomCode);
  
      io.in(roomCode).emit('auction_ended', {
        winner: !!ca.highestBidder,
        player: ca.playerName
      });
  
      // Announce next steps
      if (room.elimination.length > 0) {
        const waitElimMsg = '유찰 플레이어 경매를 시작할 때까지 관리자를 기다리는 중입니다.';
        const waitElimEntry = { username: 'SYSTEM', text: waitElimMsg, timestamp: Date.now() };
        room.chatLog.push(waitElimEntry);
        io.in(roomCode).emit('chat_update', waitElimEntry);
  
        broadcastRoomState(roomCode);
      } else if (room.auctionOrder.length > 0) {
        // Just in case (should not happen), but handle fallback
        const waitMsg = '다음 경매를 시작할 때까지 관리자를 기다리는 중입니다.';
        const waitEntry = { username: 'SYSTEM', text: waitMsg, timestamp: Date.now() };
        room.chatLog.push(waitEntry);
        io.in(roomCode).emit('chat_update', waitEntry);
  
        broadcastRoomState(roomCode);
      } else {
        if (room.adminSocketId) {
          io.to(room.adminSocketId).emit('all_auctions_complete', room.teams);
        }
        const doneMsg = '모든 경매가 완료되었습니다!';
        const doneEntry = { username: 'SYSTEM', text: doneMsg, timestamp: Date.now() };
        room.chatLog.push(doneEntry);
        io.in(roomCode).emit('chat_update', doneEntry);
      }
      return; // Don't run normal auction logic below!
    }
  
    // ─── ORIGINAL NORMAL AUCTION LOGIC BELOW (no change needed) ───
  
    // 1) If there was a highestBidder, attempt to SELL the player
    if (ca.highestBidder) {
      let winningTeamName = null;
      for (const [tName, tObj] of Object.entries(room.teams)) {
        if (tObj.captainName === ca.highestBidder) {
          winningTeamName = tName;
          break;
        }
      }
  
      if (winningTeamName) {
        const teamObj = room.teams[winningTeamName];
        // Check: do we enforce limitByTier?
        if (room.settings.limitByTier) {
          const alreadyHasTier = teamObj.members.some(m => m.tier === ca.tier);
          if (alreadyHasTier) {
            room.elimination.push({ username: ca.playerName, tier: ca.tier });
            const conflictMsg = `${ca.playerName}님은 이미 ${ca.tier} 티어 선수가 있어서 ${ca.highestBidder}님에게 배정되지 못하고 유찰되었습니다.`;
            const conflictEntry = { username: 'SYSTEM', text: conflictMsg, timestamp: Date.now() };
            room.chatLog.push(conflictEntry);
            io.in(roomCode).emit('chat_update', conflictEntry);
          } else {
            teamObj.points -= ca.highestBid;
            teamObj.members.push({ username: ca.playerName, tier: ca.tier });
  
            const soldMsg = `${ca.playerName}님이 ${ca.highestBid} 포인트에 ${ca.highestBidder}님에게 낙찰되었습니다.`;
            const soldEntry = { username: 'SYSTEM', text: soldMsg, timestamp: Date.now() };
            room.chatLog.push(soldEntry);
            io.in(roomCode).emit('chat_update', soldEntry);
          }
        } else {
          teamObj.points -= ca.highestBid;
          teamObj.members.push({ username: ca.playerName, tier: ca.tier });
  
          const soldMsg = `${ca.playerName}님이 ${ca.highestBidder}님에게 ${ca.highestBid} 포인트에 낙찰되었습니다.`;
          const soldEntry = { username: 'SYSTEM', text: soldMsg, timestamp: Date.now() };
          room.chatLog.push(soldEntry);
          io.in(roomCode).emit('chat_update', soldEntry);
        }
      }
    } else {
      // 2) No bids → move to elimination
      room.elimination.push({ username: ca.playerName, tier: ca.tier });
      const elimMsg = `${ca.playerName}님은 유찰되었습니다.`;
      const elimEntry = { username: 'SYSTEM', text: elimMsg, timestamp: Date.now() };
      room.chatLog.push(elimEntry);
      io.in(roomCode).emit('chat_update', elimEntry);
    }
  
    // Remove the player from auctionOrder, if present
    if (ca.playerName) {
      room.auctionOrder = room.auctionOrder.filter(
        entry => entry.username !== ca.playerName
      );
    }
  
    // Clear currentAuction
    room.currentAuction = null;
  
    // Broadcast updated state (teams, auctionOrder, elimination, chatLog, etc.)
    broadcastRoomState(roomCode);
  
    // Announce auction ended, with winner info for sound cue
    io.in(roomCode).emit('auction_ended', {
      winner: !!ca.highestBidder,
      player: ca.playerName
    });
  
    // 3) If more players remain, WAIT for admin to start the next auction
    if (room.auctionOrder.length > 0) {
      const waitMsg = '다음 경매를 시작할 때까지 관리자를 기다리는 중입니다.';
      const waitEntry = { username: 'SYSTEM', text: waitMsg, timestamp: Date.now() };
      room.chatLog.push(waitEntry);
      io.in(roomCode).emit('chat_update', waitEntry);

      broadcastRoomState(roomCode);
    } else if (room.elimination.length > 0) {
      const waitElimMsg = '유찰 플레이어 경매를 시작할 때까지 관리자를 기다리는 중입니다.';
      const waitElimEntry = { username: 'SYSTEM', text: waitElimMsg, timestamp: Date.now() };
      room.chatLog.push(waitElimEntry);
      io.in(roomCode).emit('chat_update', waitElimEntry);

      broadcastRoomState(roomCode);
    } else {
      // Send final summary message with all teams and members
      let summary = '🏆 모든 경매가 완료되었습니다! 최종 팀 구성:\n\n';

      for (const [teamName, team] of Object.entries(room.teams)) {
        summary += `**${teamName}** (주장: ${team.captainName ?? '없음'}, 남은 포인트: ${team.points})\n`;
        if (team.members.length === 0) {
          summary += ' - 팀원이 없습니다.\n';
        } else {
          for (const member of team.members) {
            summary += ` - ${member.username} (티어 ${member.tier})\n`;
          }
        }
        summary += '\n';
      }

      const summaryEntry = {
        username: 'SYSTEM',
        text: summary,
        timestamp: Date.now()
      };

      room.chatLog.push(summaryEntry);
      io.in(roomCode).emit('chat_update', summaryEntry);
    }

  }
  
  socket.on('disconnect', () => {
    console.log(`소켓 연결 해제됨: ${socket.id}`);
  });
});

// server.listen(PORT, () => {
//   console.log(`서버가 실행 중입니다: http://localhost:${PORT}`);
// });

server.listen(PORT, '0.0.0.0', () => {
  console.log(`서버가 실행 중입니다: http://localhost:${PORT}`);
});

