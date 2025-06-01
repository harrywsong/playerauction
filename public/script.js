// script.js
// ─────────────────────────────────────────────────────────────────────────────
// Auction Room Overhaul (v2.7+):
//   • Fixes: input field always up-to-date with current bid
//   • Quick bid buttons do NOT increment input, but immediately send bid
//   • Input resets to minimum bid after each auction
// ─────────────────────────────────────────────────────────────────────────────

const socket = io();

// ────────── ELEMENT REFERENCES ──────────
const adminView            = document.getElementById('admin-view');
const createForm           = document.getElementById('create-room-form');
const maxCaptainsInput     = document.getElementById('maxCaptains');
const initialPointsInput   = document.getElementById('initialPoints');
const playersPerTeamSelect = document.getElementById('playersPerTeam');
const limitByTierCheckbox  = document.getElementById('limitByTier');
const adminResult          = document.getElementById('admin-result');
const roomCodeDisplay      = document.getElementById('room-code-display');
const goToLobbyBtn         = document.getElementById('go-to-lobby');

const joinView          = document.getElementById('join-view');
const joinForm          = document.getElementById('join-room-form');
const joinRoomCodeInput = document.getElementById('joinRoomCode');
const joinUsernameInput = document.getElementById('joinUsername');
const joinAsCaptainChk  = document.getElementById('joinAsCaptain');
const joinTierSelect    = document.getElementById('joinTier');
const joinError         = document.getElementById('join-error');

const auctionView               = document.getElementById('auction-view');
const displayRoomCode           = document.getElementById('displayRoomCode');
const displayUsername           = document.getElementById('displayUsername');
const displayRole               = document.getElementById('displayRole');

const leftPanel                = document.querySelector('.left-panel');
const auctionOrderList         = document.getElementById('auction-order-list');
const eliminationListContainer = document.querySelector('.elimination-list');
const chatLogDiv               = document.getElementById('chat-log');
const chatInput                = document.getElementById('chat-input');
const sendChatBtn              = document.getElementById('send-chat-btn');

const mediaPlaceholder = document.querySelector('.video-placeholder');
const bidControls      = document.getElementById('bid-controls');
const timerDisplay     = document.getElementById('timer-display');
const remainingPointsSpan = document.getElementById('remaining-points');

const quickBidButtons = document.querySelectorAll('.bid-btn');
const customBidInput  = document.getElementById('custom-bid-input');
const placeBidBtn     = document.getElementById('place-bid-btn');

const infoRight = document.querySelector('.info-right');

let myRoomCode   = localStorage.getItem('roomCode')   || null;
let myUsername   = localStorage.getItem('username')   || null;
let amICaptain   = localStorage.getItem('isCaptain') === 'true';
let isHost       = false;
let roomSettings = null;
let captainMap   = {};
let userTeamColorMap = {};

// NEW: For SYSTEM color logic
let userTeamIndexMap = {};
let userTierMap = {};

let timerStartAt  = 0;
let timerDuration = 0;
let localInterval = null;
let hasPlayedEnd  = false;

// Team color mapping (customize as you wish)
const TEAM_COLORS = [
  "#4fc3f7", // Team 1 - blue
  "#f06292", // Team 2 - pink
  "#81c784", // Team 3 - green
  "#ffb74d", // Team 4 - orange
  "#ba68c8", // Team 5 - purple
];

// Tier color mapping
const TIER_COLORS = {
  "A": "#e31b1b",  // Red
  "B": "#1976d2",  // Blue
  "C": "#388e3c",  // Green
  "D": "#fbc02d",  // Yellow
  "E": "#757575",  // Gray
};

// ──────────── AUCTION STATE FOR INPUT CONTROL ────────────
window.currentAuction = {};

function updateBidInput(currentAuction) {
  if (!customBidInput) return;
  let minBid = 1;
  if (currentAuction && typeof currentAuction.highestBid === "number") {
    minBid = currentAuction.highestBid + 1;
  }
  // Always force it to the minimum bid
  customBidInput.value = minBid;
}

// ────────── INITIAL VIEW SETUP ──────────
const urlParams = new URLSearchParams(window.location.search);
if (urlParams.get('host') === 'true') {
  adminView.classList.remove('hidden');
} else {
  joinView.classList.remove('hidden');
}

function updateUserTeamColorMap(teams) {
  userTeamColorMap = {};
  let idx = 0;
  for (const [teamName, teamObj] of Object.entries(teams)) {
    if (teamObj.captainName) userTeamColorMap[teamObj.captainName] = idx;
    for (const m of teamObj.members) {
      userTeamColorMap[m.username] = idx;
    }
    idx++;
  }
}

// NEW: For advanced SYSTEM color
function updateUserMaps(teams, auctionOrder, currentAuction) {
  userTeamIndexMap = {};
  userTierMap = {};
  let idx = 0;
  for (const [teamName, teamObj] of Object.entries(teams)) {
    if (teamObj.captainName) userTeamIndexMap[teamObj.captainName] = idx;
    for (const m of teamObj.members) {
      userTeamIndexMap[m.username] = idx;
      userTierMap[m.username] = m.tier;
    }
    idx++;
  }
  // Also add auctionOrder users to userTierMap
  (auctionOrder || []).forEach((e) => {
    userTierMap[e.username] = e.tier;
  });
  // And current auction (the one on the block)
  if (currentAuction && currentAuction.playerName && currentAuction.tier) {
    userTierMap[currentAuction.playerName] = currentAuction.tier;
  }
}

// ──────────────────────────────────────────────────────────────────────────────
//   CREATE ROOM (ADMIN)
// ──────────────────────────────────────────────────────────────────────────────
createForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const maxC        = parseInt(maxCaptainsInput.value, 10);
  const ip          = parseInt(initialPointsInput.value, 10);
  const ppt         = parseInt(playersPerTeamSelect.value, 10);
  const limitByTier = limitByTierCheckbox.checked;

  if (
    isNaN(maxC) ||
    isNaN(ip) ||
    isNaN(ppt) ||
    maxC < 1 ||
    ip < 0 ||
    (ppt !== 4 && ppt !== 5)
  ) {
    alert('Please enter valid numbers and choose 4 or 5 players per team.');
    return;
  }

  const res  = await fetch(
    `/create_room?maxCaptains=${maxC}&initialPoints=${ip}&playersPerTeam=${ppt}&limitByTier=${limitByTier}`
  );
  const data = await res.json();
  myRoomCode = data.roomCode;
  roomSettings = {
    maxCaptains:    data.maxCaptains,
    initialPoints:  data.initialPoints,
    playersPerTeam: data.playersPerTeam,
    limitByTier:    data.limitByTier,
    allowedTiers:   data.playersPerTeam === 4
                      ? ['A','B','C','D']
                      : ['A','B','C','D','E']
  };

  roomCodeDisplay.textContent = myRoomCode;
  adminResult.classList.remove('hidden');
});

goToLobbyBtn.addEventListener('click', () => {
  isHost = true;
  adminView.classList.add('hidden');
  auctionView.classList.remove('hidden');

  drawEmptyTeamCards(
    roomSettings.maxCaptains,
    roomSettings.initialPoints,
    roomSettings.playersPerTeam
  );

  renderHostControls();
  displayRoomCode.textContent = myRoomCode;
  displayUsername.textContent = 'HOST';
  displayRole.textContent     = '(Admin)';
  socket.emit('host_join', { roomCode: myRoomCode });
});

// ──────────────────────────────────────────────────────────────────────────────
//   JOIN ROOM (PLAYER / CAPTAIN / SPECTATOR)
// ──────────────────────────────────────────────────────────────────────────────
joinForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const code  = joinRoomCodeInput.value.toUpperCase().trim();
  const name  = joinUsernameInput.value.trim();
  const asCap = joinAsCaptainChk.checked;
  const tier  = asCap ? null : (joinTierSelect.value || null);

  if (!code || !name) {
    joinError.textContent = 'Room code and name are required.';
    joinError.classList.remove('hidden');
    return;
  }

  myRoomCode = code;
  myUsername = name;
  amICaptain = asCap;
  localStorage.setItem('roomCode', code);
  localStorage.setItem('username', name);
  localStorage.setItem('isCaptain', asCap ? 'true' : 'false');

  joinError.classList.add('hidden');
  joinView.classList.add('hidden');
  auctionView.classList.remove('hidden');

  displayRoomCode.textContent = myRoomCode;
  displayUsername.textContent = myUsername;
  displayRole.textContent     = asCap ? '(주장)' : '';

  socket.emit('join_room', {
    roomCode:  myRoomCode,
    username:  myUsername,
    asCaptain: asCap,
    tier
  });
});

// ──────────────────────────────────────────────────────────────────────────────
//   SOCKET.IO LISTENERS
// ──────────────────────────────────────────────────────────────────────────────

socket.on('rejoin_success', (fullState) => {
  updateUserTeamColorMap(fullState.teams);
  updateUserMaps(fullState.teams, fullState.auctionOrder, fullState.currentAuction);
  roomSettings = {
    maxCaptains:    fullState.settings.maxCaptains,
    initialPoints:  fullState.settings.initialPoints,
    playersPerTeam: fullState.settings.playersPerTeam,
    limitByTier:    fullState.settings.limitByTier,
    allowedTiers:   fullState.settings.allowedTiers
  };

  buildCaptainMap(fullState.teams);
  renderTeamsAndPlayers({ teams: fullState.teams, settings: roomSettings });
  renderAuctionOrder(fullState.auctionOrder);
  renderEliminationList(fullState.elimination || []);
  renderChatLog(fullState.chatLog);

  updateCurrentMedia(fullState.currentAuction || {});
  timerDisplay.textContent = 'TIME COUNT 15.00';
  hasPlayedEnd = false;
  updateRemainingPoints(fullState);
  window.currentAuction = fullState.currentAuction || {};
  showBidControlsIfCaptain();
  updateBidInput(window.currentAuction);
});

socket.on('room_update', (data) => {
  updateUserTeamColorMap(data.teams);
  updateUserMaps(data.teams, data.auctionOrder, data.currentAuction);
  if (!roomSettings) {
    roomSettings = {
      maxCaptains:    data.settings.maxCaptains,
      initialPoints:  data.settings.initialPoints,
      playersPerTeam: data.settings.playersPerTeam,
      limitByTier:    data.settings.limitByTier,
      allowedTiers:   data.settings.allowedTiers
    };
  }
  buildCaptainMap(data.teams);
  renderTeamsAndPlayers({ teams: data.teams, settings: roomSettings });
  renderAuctionOrder(data.auctionOrder);
  renderEliminationList(data.elimination || []);
  renderChatLog(data.chatLog);

  updateCurrentMedia(data.currentAuction || {});
  updateRemainingPoints(data);
  window.currentAuction = data.currentAuction || {};
  showBidControlsIfCaptain();
  updateBidInput(window.currentAuction);
});

socket.on('chat_update', (entry) => {
  appendChatLine(entry);
});

socket.on('bid_error', (msg) => {
  alert(msg);
});

socket.on('new_highest_bid', (data) => {
  playAudio('success');
  // Update currentAuction with new highestBid
  if (!window.currentAuction) window.currentAuction = {};
  window.currentAuction.highestBid = data.highestBid;
  updateBidInput(window.currentAuction);
});

function autoAssignIfOnlyOneTeam(teams, nextPlayer, auctionOrder) {
  // 1. Get the tier of the next player
  const { tier, username } = nextPlayer;

  // 2. Check how many unassigned players of this tier are left
  const unassigned = auctionOrder.filter(p => p.tier === tier);

  if (unassigned.length !== 1) return false; // Not the last one, proceed as normal

  // 3. Find which teams still can accept a player of this tier
  let eligibleTeams = [];
  for (const team of Object.values(teams)) {
    // Count how many players of this tier are already in the team
    const countTier = team.members.filter(m => m.tier === tier).length;
    // Assume only one per tier is allowed, adjust as per your rules
    if (countTier === 0 && team.members.length < team.maxSize) {
      eligibleTeams.push(team);
    }
  }

  // 4. If only one team is eligible, auto-assign
  if (eligibleTeams.length === 1) {
    eligibleTeams[0].members.push({ username, tier });
    // Remove from auctionOrder
    const idx = auctionOrder.findIndex(p => p.username === username);
    if (idx > -1) auctionOrder.splice(idx, 1);
    // Notify chat
    io.to(roomCode).emit('chat_update', {
      username: "SYSTEM",
      text: `${username}님이 자동으로 ${eligibleTeams[0].name}에 배정되었습니다.`,
      timestamp: Date.now(),
    });
    return true; // Indicate auto-assignment happened
  }
  return false;
}


// ─── NORMAL AUCTION EVENTS ───────────────────────────────────────────────────
socket.on('auction_started', (data) => {
  playAudio('start');
  hasPlayedEnd = false;

  // Make sure playerName and tier are present in server event!
  window.currentAuction = {
    playerName: data.playerName,
    tier: data.tier,
    highestBid: 0
  };
  updateBidInput(window.currentAuction);
  startLocalCountdown(data.timer);
  showBidControlsIfCaptain();
});

socket.on('timer_tick', (timeLeft) => {
  if (timeLeft > 0) {
    playAudio('tick');
  }
  timerStartAt  = Date.now();
  timerDuration = timeLeft * 1000;
  hasPlayedEnd  = false;
});

socket.on('auction_paused', () => {
  if (localInterval) {
    clearInterval(localInterval);
    localInterval = null;
  }
  const tickAudio = document.getElementById('audio-tick');
  if (tickAudio && !tickAudio.paused) {
    tickAudio.pause();
    tickAudio.currentTime = 0;
  }
});

socket.on('auction_resumed', (data) => {
  hasPlayedEnd = false;
  startLocalCountdown(data.timer);
});

socket.on('auction_ended', (info) => {
  const tickAudio = document.getElementById('audio-tick');
  if (tickAudio && !tickAudio.paused) {
    tickAudio.pause();
    tickAudio.currentTime = 0;
  }
  playAudio(info.winner ? 'end-bought' : 'end-notbought');
  setTimeout(() => {
    updateBidInput(window.currentAuction);
  }, 100);
});

// ─── ELIMINATION AUCTION EVENTS ───────────────────────────────────────────────
socket.on('elim_auction_started', (data) => {
  playAudio('start');
  hasPlayedEnd = false;
  window.currentAuction = {
    playerName: data.playerName,
    tier: data.tier,
    highestBid: 0
  };
  updateBidInput(window.currentAuction);
  startLocalCountdown(data.timer);
  showBidControlsIfCaptain();
});

socket.on('elim_timer_tick', (timeLeft) => {
  if (timeLeft > 0) {
    playAudio('tick');
  }
  timerStartAt  = Date.now();
  timerDuration = timeLeft * 1000;
  hasPlayedEnd  = false;
});

socket.on('elim_auction_paused', () => {
  if (localInterval) {
    clearInterval(localInterval);
    localInterval = null;
  }
  const tickAudio = document.getElementById('audio-tick');
  if (tickAudio && !tickAudio.paused) {
    tickAudio.pause();
    tickAudio.currentTime = 0;
  }
});

socket.on('elim_auction_resumed', (data) => {
  hasPlayedEnd = false;
  startLocalCountdown(data.timer);
});

socket.on('elim_auction_ended', (info) => {
  const tickAudio = document.getElementById('audio-tick');
  if (tickAudio && !tickAudio.paused) {
    tickAudio.pause();
    tickAudio.currentTime = 0;
  }
  playAudio(info.winner ? 'end-bought' : 'end-notbought');
  setTimeout(() => {
    updateBidInput(window.currentAuction);
  }, 100);
});

socket.on('all_auctions_complete', (teams) => {
  // Create the JSON file as a Blob
  const json = JSON.stringify(teams, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);

  // Create a temporary download link and trigger click
  const a = document.createElement('a');
  a.href = url;
  a.download = 'final_teams.json';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();

  // Clean up
  setTimeout(() => {
    URL.revokeObjectURL(url);
    document.body.removeChild(a);
  }, 100);

  alert('경매가 종료되었습니다. 결과 파일이 다운로드되었습니다.');
});

// ──────────────────────────────────────────────────────────────────────────────
//   SEND CHAT
// ──────────────────────────────────────────────────────────────────────────────
chatInput.addEventListener('keydown', function(e) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendChatBtn.click();
  }
});

sendChatBtn.addEventListener('click', () => {
  const txt = chatInput.value.trim();
  if (!txt) return;
  const sender = isHost ? 'ADMIN' : myUsername;
  socket.emit('send_chat', {
    roomCode: myRoomCode,
    username: sender,
    text: txt
  });
  chatInput.value = '';
});

// ──────────────────────────────────────────────────────────────────────────────
//   BUILD / RENDER HELPERS
// ──────────────────────────────────────────────────────────────────────────────
function buildCaptainMap(teams) {
  captainMap = {};
  for (const [_, tObj] of Object.entries(teams)) {
    if (tObj.captainName) {
      captainMap[tObj.captainName] = true;
    }
  }
}

function drawEmptyTeamCards(n, pts, slots) {
  leftPanel.innerHTML = '';
  for (let i = 1; i <= n; i++) {
    const card = document.createElement('div');
    card.className = 'team-card';

    const header = document.createElement('div');
    header.className = 'team-header';
    header.innerHTML = `
      <span class="team-name">팀: ${i}</span>
      <span class="team-points">잔여 포인트: ${pts}</span>
    `;
    card.appendChild(header);

    const slotsDiv = document.createElement('div');
    slotsDiv.className = 'team-slots';

    for (let j = 0; j < slots; j++) {
      const slot = document.createElement('div');
      slot.className = 'slot empty';
      slotsDiv.appendChild(slot);
    }
    card.appendChild(slotsDiv);

    leftPanel.appendChild(card);
  }
}

function renderTeamsAndPlayers({ teams, settings }) {
  leftPanel.innerHTML = '';
  const memberSlots = settings.playersPerTeam;

  for (const [tName, team] of Object.entries(teams)) {
    const card = document.createElement('div');
    card.className = 'team-card';

    const header = document.createElement('div');
    header.className = 'team-header';
    header.innerHTML = `
      <span class="team-name">${tName}</span>
      <span class="team-points">잔여 포인트: ${team.points}</span>
    `;
    card.appendChild(header);

    if (team.captainName) {
      const capRow = document.createElement('div');
      capRow.className = 'team-captain';
      capRow.innerHTML = `
        <img
          src="/img/icons/${team.captainName}.png"
          alt="${team.captainName}"
          class="avatar-icon"
          onerror="this.onerror=null; this.src='/img/icons/default-icon.png';"
        >
        <span class="captain-name">${team.captainName}</span>
      `;
      card.appendChild(capRow);
    }

    const slotsDiv = document.createElement('div');
    slotsDiv.className = 'team-slots';

    for (let i = 0; i < memberSlots; i++) {
      const slot = document.createElement('div');
      if (team.members[i]) {
        const { username, tier } = team.members[i];
        slot.className = 'slot';
        slot.innerHTML = `
          <img
            src="/img/icons/${username}.png"
            alt="${username}"
            class="player-icon"
            onerror="this.onerror=null; this.src='/img/icons/default-icon.png';"
          >
          <div class="player-name">${username} (<strong>${tier}</strong>)</div>
        `;
      } else {
        slot.className = 'slot empty';
      }
      slotsDiv.appendChild(slot);
    }
    card.appendChild(slotsDiv);
    leftPanel.appendChild(card);
  }
}

function renderAuctionOrder(auctionOrder) {
  auctionOrderList.innerHTML = '';
  auctionOrder.forEach((entry) => {
    const li = document.createElement('li');
    li.innerHTML = `
      <img
        src="/img/icons/${entry.username}.png"
        alt="${entry.username}"
        class="avatar-icon"
        onerror="this.onerror=null; this.src='/img/icons/default-icon.png';"
      >
      <span class="username">${entry.username} (${entry.tier})</span>
    `;
    auctionOrderList.appendChild(li);
  });
}

function renderEliminationList(eliminationArr) {
  eliminationListContainer.innerHTML = '';
  if (!eliminationArr || eliminationArr.length === 0) {
    const p = document.createElement('p');
    p.className = 'empty-text';
    p.textContent = '아직 유찰된 플레이어가 없습니다';
    eliminationListContainer.appendChild(p);
    return;
  }
  const ul = document.createElement('ul');
  ul.style.listStyle = 'none';
  eliminationArr.forEach((entry) => {
    const li = document.createElement('li');
    li.innerHTML = `
      <img
        src="/img/icons/${entry.username}.png"
        alt="${entry.username}"
        class="avatar-icon"
        onerror="this.onerror=null; this.src='/img/icons/default-icon.png';"
      >
      <span class="username">${entry.username} (${entry.tier})</span>
    `;
    ul.appendChild(li);
  });
  eliminationListContainer.appendChild(ul);
}

function renderChatLog(chatLog) {
  chatLogDiv.innerHTML = '';
  chatLog.forEach((entry) => appendChatLine(entry));
  chatLogDiv.scrollTop = chatLogDiv.scrollHeight;
}

// THE IMPORTANT, COLORFUL SYSTEM/CHAT MESSAGE HANDLER!
function appendChatLine(entry) {
  const div = document.createElement('div');
  let timeStr = `[${new Date(entry.timestamp).toLocaleTimeString()}]`;

  // Regex for red/bold points: matches e.g. 100점, 200 포인트, 500점
  const highlightPoints = (text) =>
    text.replace(/(\d+)\s*(점|포인트)/g, '<span style="color:#ff4d4d;font-weight:bold;">$1$2</span>');

  if (entry.username === 'SYSTEM') {
    let html = entry.text.replace(/([가-힣A-Za-z0-9_]+)님/g, (match, name) => {
      let color = "#fff";
      if (userTeamIndexMap[name] !== undefined) {
        color = TEAM_COLORS[userTeamIndexMap[name] % TEAM_COLORS.length];
      } else if (userTierMap[name] && TIER_COLORS[userTierMap[name]]) {
        color = TIER_COLORS[userTierMap[name]];
      }
      return `<span style="color:${color};font-weight:bold;">${match}</span>`;
    });
    html = highlightPoints(html);
    div.innerHTML = `<span style="color:#aaa;">${timeStr}</span> <span style="color:#ffd369;">SYSTEM</span><span style="color:#aaa;">:</span> ${html}`;
    div.classList.add('chat-line', 'system');
  } else {
    let nameColor = "#fff";
    if (userTeamIndexMap[entry.username] !== undefined) {
      nameColor = TEAM_COLORS[userTeamIndexMap[entry.username] % TEAM_COLORS.length];
    } else if (userTierMap[entry.username] && TIER_COLORS[userTierMap[entry.username]]) {
      nameColor = TIER_COLORS[userTierMap[entry.username]];
    }
    // The colon is always gray (#aaa). Both username and text are colored by team/tier.
    let messageHtml = `<span style="color:#aaa;">${timeStr}</span> <span style="color:${nameColor};">${entry.username}</span><span style="color:#aaa;">:</span> <span style="color:${nameColor};">${entry.text}</span>`;
    messageHtml = highlightPoints(messageHtml);
    div.innerHTML = messageHtml;
    div.classList.add('chat-line');
    if (entry.username === 'ADMIN') div.classList.add('admin');
    else if (captainMap[entry.username]) div.classList.add('captain');
  }
  chatLogDiv.appendChild(div);
  chatLogDiv.scrollTop = chatLogDiv.scrollHeight;
}


// ──────────────────────────────────────────────────────────────────────────────
//   MIDDLE MEDIA DISPLAY
// ──────────────────────────────────────────────────────────────────────────────
function updateCurrentMedia(currentAuction) {
  const defaultImgPath = '/img/display/default-display.png';
  const defaultVideoPath = '/img/display/default-display.mp4'; // Your mp4 here!

  if (!mediaPlaceholder) return;

  if (!currentAuction || !currentAuction.playerName) {
    // Use video for default, with image fallback
    mediaPlaceholder.innerHTML = `
      <video class="media-video" autoplay loop muted playsinline>
        <source src="${defaultVideoPath}" type="video/mp4">
        <img src="${defaultImgPath}" alt="Default" class="media-img">
      </video>
    `;

    return;
  }

  const name = currentAuction.playerName;
  const imgPath = `/img/display/${name}.png`;
  mediaPlaceholder.innerHTML = `
    <img
      src="${imgPath}"
      alt="${name}"
      class="media-img"
      onerror="this.onerror=null; this.src='${defaultImgPath}';"
    >
  `;
}

// ──────────────────────────────────────────────────────────────────────────────
//   REMAINING POINTS & BID CONTROLS
// ──────────────────────────────────────────────────────────────────────────────
function updateRemainingPoints(data) {
  if (!remainingPointsSpan) return;
  let myPoints = 0;
  for (const tObj of Object.values(data.teams)) {
    if (tObj.captainName === myUsername) {
      myPoints = tObj.points;
      break;
    }
  }
  remainingPointsSpan.textContent = myPoints;
}

function showBidControlsIfCaptain() {
  if (!window.currentAuction || !window.currentAuction.playerName) {
    bidControls.classList.add('hidden');
    return;
  }
  if (amICaptain || isHost) {
    bidControls.classList.remove('hidden');
    updateBidInput(window.currentAuction);
    // updateRemainingPoints(); // Optionally pass data here if available
  } else {
    bidControls.classList.add('hidden');
  }
}

// ──────────────────────────────────────────────────────────────────────────────
//   QUICK BID BUTTONS (NO INCREMENTING, JUST SUBMIT BID)
// ──────────────────────────────────────────────────────────────────────────────
quickBidButtons.forEach((btn) => {
  btn.addEventListener('click', () => {
    const inc = parseInt(btn.dataset.increment, 10); // +5, +10, etc
    let currentBid = 0;
    if (window.currentAuction && typeof window.currentAuction.highestBid === "number") {
      currentBid = window.currentAuction.highestBid;
    }
    let bid = currentBid + inc;

    // Make sure bid is at least minimum allowed (currentBid + 1)
    if (bid <= currentBid) bid = currentBid + 1;

    // Make sure bid does not exceed available points
    const available = parseInt(remainingPointsSpan.textContent, 10);
    if (bid > available) return;

    socket.emit('place_bid', {
      roomCode:    myRoomCode,
      captainName: myUsername,
      amount:      bid
    });
  });
});

placeBidBtn.addEventListener('click', () => {
  const raw    = customBidInput.value.trim();
  const amount = parseInt(raw, 10);
  if (isNaN(amount) || amount <= 0) {
    alert('올바른 입찰 포인트를 입력하세요.');
    return;
  }
  socket.emit('place_bid', {
    roomCode:    myRoomCode,
    captainName: myUsername,
    amount
  });
});

// ──────────────────────────────────────────────────────────────────────────────
//   HIGH‑RESOLUTION COUNTDOWN (Hundredths of a second)
// ──────────────────────────────────────────────────────────────────────────────
function startLocalCountdown(durationSeconds) {
  if (localInterval) {
    clearInterval(localInterval);
    localInterval = null;
  }
  timerStartAt  = Date.now();
  timerDuration = durationSeconds * 1000;
  hasPlayedEnd  = false;
  updateTimerDisplayMS();
  localInterval = setInterval(updateTimerDisplayMS, 50);
}
function updateTimerDisplayMS() {
  const elapsed = Date.now() - timerStartAt;
  let remain    = timerDuration - elapsed;
  if (remain <= 0) {
    remain = 0;
    if (localInterval) {
      clearInterval(localInterval);
      localInterval = null;
    }
  }
  const seconds = Math.floor(remain / 1000);
  const ms      = Math.floor((remain % 1000) / 10); // hundredths
  timerDisplay.textContent = `TIME COUNT ${String(seconds).padStart(2, '0')}.${String(ms).padStart(2, '0')}`;
}

// ──────────────────────────────────────────────────────────────────────────────
//   HOST CONTROLS (ADMIN): Start, Pause, Resume, Shuffle, Seed, Elimination
// ──────────────────────────────────────────────────────────────────────────────
function renderHostControls() {
  const existing = document.getElementById('host-control-panel');
  if (existing) existing.remove();
  const ctrl = document.createElement('div');
  ctrl.id = 'host-control-panel';
  ctrl.innerHTML = `
    <!-- 일반 경매 컨트롤 -->
    <input type="text" id="seed-url-input" placeholder="시트 CSV URL" style="width:88px;" />
    <button id="seed-url-btn">URL에서 시드 불러오기</button>
    <button id="start-btn">경매 시작</button>
    <button id="shuffle-btn">경매 순서 섞기</button>
    <span style="width:100%; border-top:1px solid #3c4f5d; margin:4px 0;"></span>
    <!-- 유찰 경매 컨트롤 -->
    <button id="start-elim-btn">유찰경매 시작</button>
  `;
  infoRight.appendChild(ctrl);
  document.getElementById('start-btn').addEventListener('click', () => {
    socket.emit('start_auction', { roomCode: myRoomCode });
  });
  document.getElementById('shuffle-btn').addEventListener('click', () => {
    socket.emit('shuffle_auction', { roomCode: myRoomCode });
  });
  document.getElementById('seed-url-btn').addEventListener('click', async () => {
    const url = document.getElementById('seed-url-input').value.trim();
    if (!url) {
      return alert('Please paste a valid Google Sheets CSV URL.');
    }
    try {
      const resp    = await fetch(url);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const csvText = await resp.text();
      const wb      = XLSX.read(csvText, { type: 'string', raw: false });
      const firstSheetName = wb.SheetNames[0];
      const sheet          = wb.Sheets[firstSheetName];
      const rows           = XLSX.utils.sheet_to_json(sheet, { header: 1 });
      const entries = [];
      for (let i = 1; i < rows.length; i++) {
        const row = rows[i];
        if (!row || row.length < 2) continue;
        const unameRaw = row[0];
        const tierRaw  = row[1];
        const username = typeof unameRaw === 'string'
                         ? unameRaw.trim()
                         : String(unameRaw).trim();
        const tierCandidate = typeof tierRaw === 'string'
                              ? tierRaw.trim().toUpperCase()
                              : String(tierRaw).trim().toUpperCase();
        if (
          username.length > 0 &&
          roomSettings.allowedTiers.includes(tierCandidate)
        ) {
          entries.push({ username, tier: tierCandidate });
        }
      }
      if (entries.length === 0) {
        const totalRows = rows.length - 1;
        return alert(
          `No valid rows found in the sheet.\n` +
          `Parsed ${totalRows} data row${totalRows !== 1 ? 's' : ''}.\n` +
          `Allowed tiers: ${roomSettings.allowedTiers.join(', ')}.\n` +
          `Check the console (F12) for the raw “rows” data.`
        );
      }
      socket.emit('seed_auction', { roomCode: myRoomCode, entries });
    } catch (err) {
      alert('Failed to load/parse sheet: ' + err.message);
    }
  });
  document.getElementById('start-elim-btn').addEventListener('click', () => {
    socket.emit('start_elim_auction', { roomCode: myRoomCode });
  });
}

// If not a captain, hide bid controls immediately
if (!amICaptain) {
  bidControls.classList.add('hidden');
}

// ──────────────────────────────────────────────────────────────────────────────
//   PLAY AUDIO (utility)
// ──────────────────────────────────────────────────────────────────────────────
function playAudio(type) {
  const map = {
    'start':         'audio-start',
    'tick':          'audio-tick',
    'success':       'audio-success',
    'end-bought':    'audio-end-bought',
    'end-notbought': 'audio-end-notbought'
  };
  const a = document.getElementById(map[type]);
  if (!a) return;
  a.currentTime = 0;
  a.play().catch(() => {});
}

document.addEventListener('DOMContentLoaded', function() {
  const copyBtn = document.getElementById('copy-room-code');
  const codeSpan = document.getElementById('room-code-display');
  if (copyBtn && codeSpan) {
    copyBtn.addEventListener('click', () => {
      const code = codeSpan.textContent;
      if (!code) return;
      // Try using the Clipboard API
      navigator.clipboard.writeText(code).then(() => {
        copyBtn.textContent = '복사됨!';
        setTimeout(() => { copyBtn.textContent = '코드 복사'; }, 1500);
      }).catch(() => {
        // Fallback for unsupported browsers or HTTP
        try {
          const textarea = document.createElement('textarea');
          textarea.value = code;
          document.body.appendChild(textarea);
          textarea.select();
          document.execCommand('copy');
          document.body.removeChild(textarea);
          copyBtn.textContent = '복사됨!';
          setTimeout(() => { copyBtn.textContent = '코드 복사'; }, 1500);
        } catch (err) {
          alert('복사를 지원하지 않는 브라우저입니다.');
        }
      });
    });
  }
});

