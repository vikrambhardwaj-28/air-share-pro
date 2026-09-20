sessionStorage.clear();
if (window.location.hash) {
  history.replaceState(null, null, window.location.pathname);
}

let myPin = "";
let peer = null;
let dataConn = null;
let audioCtx = null;
let isListening = false;
let listenStream = null;
let listenAnimId = null;

let isRemoteTyping = false;

const START_TONE = 1450;
const SEPARATOR_TONE = 1700;
const FREQ_BASE = 2000;
const FREQ_STEP = 150;
const DIGIT_DURATION = 0.16;
const SYNC_DURATION = 0.10;

// High-speed chunk & backpressure sizing
const CHUNK_SIZE = 64 * 1024;
const BUFFER_MAX_THRESHOLD = 1024 * 1024;

let isTransferAborted = false;
let currentTransferId = null;
let transferStartTime = 0;
let lastProgressSentTime = 0;
let bytesSamplePeriod = 0;
let activeReader = null;
let activeDrainTimer = null;
let activeSliceCallback = null;

// Receiver state
let incomingFileMeta = null;
let incomingFileChunks = [];
let incomingBytesReceived = 0;
let receiverWatchdogTimer = null;
const fileBlobsMap = new Map();

// UI Elements
const statusLabel = document.getElementById("statusLabel");
const statusDot = document.getElementById("statusDot");
const disconnectBtn = document.getElementById("disconnectBtn");
const pairingSection = document.getElementById("pairingSection");
const transferSection = document.getElementById("transferSection");

const pinDisplay = document.getElementById("pinDisplay");
const qrcodeContainer = document.getElementById("qrcode");
const manualPinInput = document.getElementById("manualPinInput");
const connectPinBtn = document.getElementById("connectPinBtn");
const emitSoundBtn = document.getElementById("emitSoundBtn");
const listenSoundBtn = document.getElementById("listenSoundBtn");
const listenBtnText = document.getElementById("listenBtnText");
const visualizerCanvas = document.getElementById("visualizerCanvas");
const visualizerCtx = visualizerCanvas.getContext("2d");

const senderProgressCard = document.getElementById("senderProgressCard");
const progressFileName = document.getElementById("progressFileName");
const progressSpeed = document.getElementById("progressSpeed");
const progressETA = document.getElementById("progressETA");
const progressBytesRatio = document.getElementById("progressBytesRatio");
const progressPercent = document.getElementById("progressPercent");
const progressBarFill = document.getElementById("progressBarFill");
const cancelTransferBtn = document.getElementById("cancelTransferBtn");

const receiverNoticeBanner = document.getElementById("receiverNoticeBanner");
const receivingNoticeFullText = document.getElementById("receivingNoticeFullText");
const sessionFilesList = document.getElementById("sessionFilesList");

const clipboardArea = document.getElementById("clipboardArea");
const pasteDeviceBtn = document.getElementById("pasteDeviceBtn");
const copyDeviceBtn = document.getElementById("copyDeviceBtn");
const copyBtnText = document.getElementById("copyBtnText");
const fileInput = document.getElementById("fileInput");

const feedbackForm = document.getElementById("feedbackForm");
const feedbackSubmitBtn = document.getElementById("feedbackSubmitBtn");
const feedbackBtnText = document.getElementById("feedbackBtnText");
const feedbackSuccessBanner = document.getElementById("feedbackSuccessBanner");

// STUN + OpenRelay TURN servers for symmetric NAT penetration (Airtel vs Jio)
const GLOBAL_ICE_SERVERS = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
  { urls: "stun:stun2.l.google.com:19302" },
  { urls: "stun:stun.cloudflare.com:3478" },
  {
    urls: "turn:openrelay.metered.ca:80",
    username: "openrelayproject",
    credential: "openrelayproject"
  },
  {
    urls: "turn:openrelay.metered.ca:443",
    username: "openrelayproject",
    credential: "openrelayproject"
  },
  {
    urls: "turn:openrelay.metered.ca:443?transport=tcp",
    username: "openrelayproject",
    credential: "openrelayproject"
  }
];

function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}

function getCurrentTimeStr() {
  const now = new Date();
  let hours = now.getHours();
  const minutes = (now.getMinutes() < 10 ? '0' : '') + now.getMinutes();
  const ampm = hours >= 12 ? 'PM' : 'AM';
  hours = hours % 12 || 12;
  return hours + ":" + minutes + " " + ampm;
}

function triggerQuantumWarp() {
  const warp = document.getElementById('quantumWarp');
  if (warp) {
    warp.classList.add('warp-active');
    setTimeout(() => warp.classList.remove('warp-active'), 700);
  }
}

function generatePIN() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

function kickReceiverWatchdog() {
  clearTimeout(receiverWatchdogTimer);
  receiverWatchdogTimer = setTimeout(() => {
    if (incomingFileMeta) {
      console.warn("Watchdog timeout triggered. Clearing hung state.");
      resetTransferUI();
    }
  }, 8000);
}

// Resilient Peer Initialization (Primary: Self-hosted, Fallback: Cloud)
function initConduit() {
  myPin = generatePIN();
  pinDisplay.innerText = myPin;

  qrcodeContainer.innerHTML = "";
  const joinUrl = `${window.location.origin}${window.location.pathname}#pin=${myPin}`;
  new QRCode(qrcodeContainer, {
    text: joinUrl,
    width: 120,
    height: 120,
    colorDark: "#0f172a",
    colorLight: "#ffffff",
    correctLevel: QRCode.CorrectLevel.M
  });

  if (peer) {
    try { peer.destroy(); } catch (e) {}
  }

  let isConnectedToSignal = false;

  // Attempt 1: Local / Render PeerServer
  peer = new Peer(`airshare-${myPin}`, {
    host: window.location.hostname,
    port: window.location.port || (window.location.protocol === 'https:' ? 443 : 80),
    path: '/peerjs',
    secure: window.location.protocol === 'https:',
    config: {
      iceServers: GLOBAL_ICE_SERVERS,
      iceCandidatePoolSize: 10
    }
  });

  peer.on("open", (id) => {
    isConnectedToSignal = true;
    statusLabel.innerText = "Ready";
    statusDot.style.background = "var(--success)";
  });

  peer.on("connection", (conn) => {
    setupDataConnection(conn);
  });

  // Attempt 2: Auto fallback to high-availability PeerJS cloud if Render socket drops
  function activateFallbackCloud() {
    if (isConnectedToSignal) return;
    console.warn("Self-hosted signal delayed. Switching to Cloud Peer Mesh...");
    if (peer) {
      try { peer.destroy(); } catch (e) {}
    }
    peer = new Peer(`airshare-${myPin}`, {
      config: {
        iceServers: GLOBAL_ICE_SERVERS,
        iceCandidatePoolSize: 10
      }
    });

    peer.on("open", () => {
      isConnectedToSignal = true;
      statusLabel.innerText = "Ready (Relay)";
      statusDot.style.background = "var(--success)";
    });

    peer.on("connection", (conn) => setupDataConnection(conn));
    peer.on("error", (err) => console.error("Signal Fallback Error:", err));
  }

  const fallbackTimer = setTimeout(activateFallbackCloud, 2500);

  peer.on("error", (err) => {
    console.warn("PeerJS Notice:", err);
    if (!isConnectedToSignal) {
      clearTimeout(fallbackTimer);
      activateFallbackCloud();
    } else if (err.type === "peer-unavailable") {
      alert("The remote device is offline or the PIN is incorrect.");
      handleDisconnection(true);
    }
  });
}

function connectToPeer(targetPin) {
  if (!targetPin || targetPin.length !== 6) return alert("Please enter a valid 6-digit PIN.");
  statusLabel.innerText = `Connecting...`;

  const conn = peer.connect(`airshare-${targetPin}`, { 
    reliable: true
  });
  setupDataConnection(conn);
}

function setupDataConnection(conn) {
  dataConn = conn;

  dataConn.on("open", () => {
    stopListeningAudio();
    statusLabel.innerText = "Connected with Peer";
    triggerQuantumWarp();

    if (dataConn.dataChannel) {
      dataConn.dataChannel.bufferedAmountLowThreshold = 128 * 1024;
    }

    if (pairingSection) pairingSection.classList.add("conduit-hidden");
    if (transferSection) transferSection.classList.add("conduit-unblurred");
    if (disconnectBtn) disconnectBtn.style.display = "inline-flex";

    window.scrollTo({ top: 0, behavior: 'smooth' });
  });

  dataConn.on("data", (data) => {
    // 1. JSON String Control Messages
    if (typeof data === "string") {
      try {
        const msg = JSON.parse(data);

        if (msg.type === "clipboard") {
          isRemoteTyping = true;
          clipboardArea.value = msg.text;
          setTimeout(() => { isRemoteTyping = false; }, 35);
        } 
        else if (msg.type === "file-start") {
          incomingFileMeta = msg;
          incomingFileChunks = [];
          incomingBytesReceived = 0;
          currentTransferId = msg.transferId;
          isTransferAborted = false;

          senderProgressCard.style.display = "none";
          receivingNoticeFullText.innerHTML = `Receiving <strong style="color:var(--apple-cyan);">${msg.name}</strong>... <span style="color:var(--apple-cyan); font-weight:700;">(0%)</span>`;
          receiverNoticeBanner.style.display = "flex";
          kickReceiverWatchdog();

          try {
            dataConn.send(JSON.stringify({
              type: "file-start-ack",
              transferId: msg.transferId
            }));
          } catch (e) {}
        }
        else if (msg.type === "file-start-ack") {
          if (activeSliceCallback) {
            activeSliceCallback();
          }
        }
        else if (msg.type === "file-progress") {
          if (incomingFileMeta && msg.transferId === currentTransferId) {
            receivingNoticeFullText.innerHTML = `Receiving <strong style="color:var(--apple-cyan);">${incomingFileMeta.name}</strong>... <span style="color:var(--apple-cyan); font-weight:700;">(${msg.pct}%)</span> • <span style="color:var(--success); font-family:'JetBrains Mono',monospace;">${msg.speed}</span>`;
            kickReceiverWatchdog();
          }
        }
        else if (msg.type === "file-abort") {
          clearTimeout(receiverWatchdogTimer);
          resetTransferUI();
        }
        else if (msg.type === "file-delete") {
          const item = document.getElementById(`file-item-${msg.fileId}`);
          if (item) item.remove();
          fileBlobsMap.delete(msg.fileId);
          updateHistoryEmptyState();
        }
        else if (msg.type === "peer-disconnect") {
          handleDisconnection(false);
        }
        else if (msg.type === "file-end") {
          clearTimeout(receiverWatchdogTimer);
          receiverNoticeBanner.style.display = "none";

          if (incomingFileMeta && !isTransferAborted) {
            const transferId = incomingFileMeta.transferId;
            const fileName = incomingFileMeta.name;
            const fileSize = incomingFileMeta.size;
            const fileTime = incomingFileMeta.time;
            const mime = incomingFileMeta.mime || "application/octet-stream";

            const safeBlob = new Blob(incomingFileChunks, { type: mime });
            fileBlobsMap.set(transferId, { blob: safeBlob, name: fileName });

            renderFileInHistory(fileName, fileSize, transferId, false, fileTime);
            triggerFileDownload(transferId);

            incomingFileMeta = null;
            incomingFileChunks = [];
          }
        }
      } catch (e) {
        console.error("Control packet error:", e);
      }
    } 
    // 2. Binary Packets
    else {
      if (!incomingFileMeta || isTransferAborted) return;
      kickReceiverWatchdog();

      let chunkBuffer = null;
      if (data instanceof ArrayBuffer) {
        chunkBuffer = data;
      } else if (ArrayBuffer.isView(data)) {
        chunkBuffer = data.buffer;
      }

      if (chunkBuffer) {
        incomingFileChunks.push(chunkBuffer);
        incomingBytesReceived += chunkBuffer.byteLength;
      }
    }
  });

  dataConn.on("close", () => {
    handleDisconnection(false);
  });
}

window.disconnectConduit = function() {
  if (confirm("Disconnect this active session?")) {
    if (dataConn && dataConn.open) {
      try {
        dataConn.send(JSON.stringify({ type: "peer-disconnect" }));
      } catch (e) {}
    }
    handleDisconnection(true);
  }
};

function handleDisconnection(isInitiator) {
  if (dataConn) {
    try { dataConn.close(); } catch (e) {}
    dataConn = null;
  }

  clearTimeout(receiverWatchdogTimer);
  resetTransferUI();

  statusLabel.innerText = "Ready";
  statusDot.style.background = "var(--success)";

  if (disconnectBtn) disconnectBtn.style.display = "none";
  if (pairingSection) pairingSection.classList.remove("conduit-hidden");
  if (transferSection) transferSection.classList.remove("conduit-unblurred");

  manualPinInput.value = "";
  clipboardArea.value = "";

  myPin = generatePIN();
  pinDisplay.innerText = myPin;
  qrcodeContainer.innerHTML = "";
  const joinUrl = `${window.location.origin}${window.location.pathname}#pin=${myPin}`;
  new QRCode(qrcodeContainer, {
    text: joinUrl,
    width: 120,
    height: 120,
    colorDark: "#0f172a",
    colorLight: "#ffffff",
    correctLevel: QRCode.CorrectLevel.M
  });

  if (!isInitiator) {
    alert("The remote peer has disconnected.");
  }
}

function resetTransferUI() {
  clearTimeout(receiverWatchdogTimer);
  clearTimeout(activeDrainTimer);
  activeSliceCallback = null;
  if (activeReader) {
    try { activeReader.abort(); } catch (e) {}
    activeReader = null;
  }

  senderProgressCard.style.display = "none";
  receiverNoticeBanner.style.display = "none";
  incomingFileMeta = null;
  incomingFileChunks = [];
  incomingBytesReceived = 0;
  isTransferAborted = true;
  currentTransferId = null;
}

// Live Shared Clipboard with anti-echo protection
clipboardArea.addEventListener("input", (e) => {
  if (isRemoteTyping) return;
  if (dataConn && dataConn.open) {
    try {
      dataConn.send(JSON.stringify({ type: "clipboard", text: e.target.value }));
    } catch (err) {}
  }
});

pasteDeviceBtn.addEventListener("click", async () => {
  try {
    const text = await navigator.clipboard.readText();
    clipboardArea.value = text;
    if (dataConn && dataConn.open) {
      dataConn.send(JSON.stringify({ type: "clipboard", text }));
    }
  } catch (err) {
    alert("Clipboard read permission is required to paste.");
  }
});

copyDeviceBtn.addEventListener("click", async () => {
  await navigator.clipboard.writeText(clipboardArea.value);
  copyBtnText.innerText = "Copied!";
  setTimeout(() => (copyBtnText.innerText = "Copy All"), 1200);
});

fileInput.addEventListener("change", (e) => {
  const files = Array.from(e.target.files);
  if (!files.length || !dataConn || !dataConn.open) return;
  files.forEach(sendFileStream);
  fileInput.value = "";
});

cancelTransferBtn.addEventListener("click", () => {
  isTransferAborted = true;
  if (dataConn && dataConn.open) {
    try {
      dataConn.send(JSON.stringify({ type: "file-abort", transferId: currentTransferId }));
    } catch (e) {}
  }
  resetTransferUI();
});

// Paced sequential chunk streaming
function sendFileStream(file) {
  isTransferAborted = false;
  currentTransferId = "file-" + Date.now();
  const fileTime = getCurrentTimeStr();

  senderProgressCard.style.display = "block";
  progressFileName.innerText = file.name;
  progressBytesRatio.innerText = `0 B / ${formatBytes(file.size)}`;
  progressPercent.innerText = "0%";
  progressBarFill.style.width = "0%";
  progressSpeed.innerText = "Starting...";
  progressETA.innerText = "ETA: --";

  transferStartTime = performance.now();
  lastProgressSentTime = transferStartTime;
  bytesSamplePeriod = 0;

  fileBlobsMap.set(currentTransferId, { blob: file, name: file.name });

  try {
    dataConn.send(JSON.stringify({
      type: "file-start",
      transferId: currentTransferId,
      name: file.name,
      size: file.size,
      mime: file.type,
      time: fileTime
    }));
  } catch (e) {
    alert("Connection failed. Please re-pair devices.");
    resetTransferUI();
    return;
  }

  let offset = 0;
  const channel = dataConn.dataChannel || (dataConn._dc);
  const reader = new FileReader();
  activeReader = reader;

  function readNextSlice() {
    if (isTransferAborted) return;

    if (offset >= file.size) {
      function drainAndFinish() {
        if (isTransferAborted) return;
        if (channel && channel.bufferedAmount > 0) {
          activeDrainTimer = setTimeout(drainAndFinish, 20);
        } else {
          try {
            dataConn.send(JSON.stringify({ type: "file-end", transferId: currentTransferId }));
          } catch (e) {}
          renderFileInHistory(file.name, file.size, currentTransferId, true, fileTime);
          setTimeout(resetTransferUI, 500);
        }
      }
      drainAndFinish();
      return;
    }

    if (channel && channel.bufferedAmount > BUFFER_MAX_THRESHOLD) {
      channel.onbufferedamountlow = () => {
        channel.onbufferedamountlow = null;
        readNextSlice();
      };
      return;
    }

    const sliceEnd = Math.min(offset + CHUNK_SIZE, file.size);
    const blobSlice = file.slice(offset, sliceEnd);
    reader.readAsArrayBuffer(blobSlice);
  }

  reader.onload = function(e) {
    if (isTransferAborted) return;

    const buffer = e.target.result;
    try {
      dataConn.send(buffer);
      offset += buffer.byteLength;
      bytesSamplePeriod += buffer.byteLength;

      const now = performance.now();
      const timeDiff = (now - lastProgressSentTime) / 1000;

      if (timeDiff >= 0.1 || offset >= file.size) {
        const bytesPerSec = bytesSamplePeriod / timeDiff;
        const speedMB = bytesPerSec / (1024 * 1024);
        const speedStr = speedMB >= 1 ? `${speedMB.toFixed(2)} MB/s` : `${(bytesPerSec / 1024).toFixed(1)} KB/s`;

        const remainingBytes = Math.max(0, file.size - offset);
        let etaStr = "ETA: --";
        if (bytesPerSec > 0 && remainingBytes > 0) {
          const etaSec = Math.round(remainingBytes / bytesPerSec);
          etaStr = etaSec >= 60 ? `ETA: ~${Math.floor(etaSec / 60)}m ${etaSec % 60}s` : `ETA: ~${etaSec}s`;
        }

        const pct = Math.min(100, Math.floor((offset / file.size) * 100));

        progressBytesRatio.innerText = `${formatBytes(offset)} / ${formatBytes(file.size)}`;
        progressPercent.innerText = `${pct}%`;
        progressBarFill.style.width = `${pct}%`;
        progressSpeed.innerText = speedStr;
        progressETA.innerText = etaStr;

        try {
          dataConn.send(JSON.stringify({
            type: "file-progress",
            transferId: currentTransferId,
            pct: pct,
            speed: speedStr
          }));
        } catch (err) {}

        bytesSamplePeriod = 0;
        lastProgressSentTime = now;
      }

      if (!channel || channel.bufferedAmount <= BUFFER_MAX_THRESHOLD) {
        readNextSlice();
      } else {
        channel.onbufferedamountlow = () => {
          channel.onbufferedamountlow = null;
          readNextSlice();
        };
      }
    } catch (err) {
      console.error("Transmission error, retrying slice:", err);
      setTimeout(readNextSlice, 40);
    }
  };

  activeSliceCallback = () => {
    activeSliceCallback = null;
    readNextSlice();
  };

  setTimeout(() => {
    if (activeSliceCallback) activeSliceCallback();
  }, 500);
}

window.triggerFileDownload = function(fileId) {
  const item = fileBlobsMap.get(fileId);
  if (!item || !item.blob) return;

  const { blob, name } = item;
  const blobUrl = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.style.display = "none";
  a.href = blobUrl;
  a.download = name;
  a.rel = "noopener";

  document.body.appendChild(a);
  a.click();

  setTimeout(() => {
    document.body.removeChild(a);
    window.URL.revokeObjectURL(blobUrl);
  }, 12000);
};

function renderFileInHistory(name, size, fileId, isSender, timeStr) {
  const item = document.createElement("div");
  item.id = `file-item-${fileId}`;
  item.className = "history-item";

  item.innerHTML = `
    <div style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap; flex:1;">
      <div style="font-weight:700; color:var(--text-primary);">${name}</div>
      <div style="font-size:0.7rem; color:var(--text-tertiary); margin-top:2px; font-weight:600;">
        ${formatBytes(size)} • <span style="color:${isSender ? 'var(--apple-cyan)' : 'var(--success)'}; font-weight:800;">${isSender ? 'Sent' : 'Received'}</span> • ${timeStr || getCurrentTimeStr()}
      </div>
    </div>
    <div style="display:flex; align-items:center; gap:8px;">
      <button onclick="triggerFileDownload('${fileId}')" style="background:var(--success); color:#fff; border:none; padding:5px 10px; border-radius:999px; font-size:0.75rem; cursor:pointer; font-weight:700;">
        <i class="fa-solid fa-download"></i> Save
      </button>
      <button onclick="deleteFile('${fileId}')" style="background:rgba(255,69,58,0.18); color:var(--danger); border:1px solid rgba(255,69,58,0.3); padding:5px 8px; border-radius:8px; font-size:0.75rem; cursor:pointer;">
        <i class="fa-solid fa-trash-can"></i>
      </button>
    </div>
  `;

  sessionFilesList.prepend(item);
  updateHistoryEmptyState();
}

window.deleteFile = function(fileId) {
  if (confirm("Delete this file for both connected devices?")) {
    const item = document.getElementById(`file-item-${fileId}`);
    if (item) item.remove();
    fileBlobsMap.delete(fileId);
    updateHistoryEmptyState();

    if (dataConn && dataConn.open) {
      dataConn.send(JSON.stringify({ type: "file-delete", fileId: fileId }));
    }
  }
};

function updateHistoryEmptyState() {
  const emptyMsg = sessionFilesList.querySelector("p");
  const hasItems = sessionFilesList.querySelector(".history-item");
  if (hasItems && emptyMsg) {
    emptyMsg.remove();
  } else if (!hasItems && !emptyMsg) {
    sessionFilesList.innerHTML = `<p style="font-size:0.78rem; color:var(--text-tertiary); font-style:italic;">No files transferred yet.</p>`;
  }
}

// Acoustic FSK Sound Engine
function getAudioContext() {
  if (!audioCtx) {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    audioCtx = new AudioCtx();
  }
  if (audioCtx.state === "suspended") audioCtx.resume();
  return audioCtx;
}

function playTone(freq, time, duration) {
  const ctx = getAudioContext();
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = "sine";
  osc.frequency.setValueAtTime(freq, time);

  gain.gain.setValueAtTime(0.0001, time);
  gain.gain.exponentialRampToValueAtTime(0.4, time + 0.015);
  gain.gain.setValueAtTime(0.4, time + duration - 0.015);
  gain.gain.exponentialRampToValueAtTime(0.0001, time + duration);

  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start(time);
  osc.stop(time + duration);
}

emitSoundBtn.addEventListener("click", () => {
  const ctx = getAudioContext();
  let t = ctx.currentTime + 0.1;

  emitSoundBtn.innerText = "Emitting...";
  emitSoundBtn.style.opacity = "0.7";

  playTone(START_TONE, t, 0.25);
  t += 0.25 + 0.05;

  for (let i = 0; i < myPin.length; i++) {
    const digit = parseInt(myPin[i], 10);
    const freq = FREQ_BASE + (digit * FREQ_STEP);
    playTone(freq, t, DIGIT_DURATION);
    t += DIGIT_DURATION + 0.02;

    if (i < myPin.length - 1) {
      playTone(SEPARATOR_TONE, t, SYNC_DURATION);
      t += SYNC_DURATION + 0.02;
    }
  }

  setTimeout(() => {
    emitSoundBtn.innerHTML = `<i class="fa-solid fa-wave-square"></i> Emit Sound PIN`;
    emitSoundBtn.style.opacity = "1";
  }, (t - ctx.currentTime) * 1000);
});

listenSoundBtn.addEventListener("click", async () => {
  if (isListening) return stopListeningAudio();

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
    });

    listenStream = stream;
    isListening = true;
    visualizerCanvas.style.display = "block";
    listenBtnText.innerText = "Listening...";
    listenSoundBtn.style.borderColor = "var(--apple-cyan)";

    const ctx = getAudioContext();
    const src = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 4096;
    analyser.smoothingTimeConstant = 0.15;
    src.connect(analyser);

    const bufferLength = analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);
    const sampleRate = ctx.sampleRate;

    let detectedDigits = [];
    let machineState = "WAIT_PREAMBLE";
    let lastValidDetectionTime = 0;

    function detectLoop() {
      if (!isListening) return;

      analyser.getByteFrequencyData(dataArray);

      visualizerCtx.clearRect(0, 0, visualizerCanvas.width, visualizerCanvas.height);
      visualizerCtx.fillStyle = "#38bdf8";

      let maxEnergy = 0;
      let peakBin = -1;
      const minBin = Math.floor((1300 * analyser.fftSize) / sampleRate);
      const maxBin = Math.floor((3600 * analyser.fftSize) / sampleRate);

      for (let i = minBin; i <= maxBin; i++) {
        if (dataArray[i] > maxEnergy) {
          maxEnergy = dataArray[i];
          peakBin = i;
        }
      }

      if (peakBin !== -1) {
        const x = ((peakBin - minBin) / (maxBin - minBin)) * visualizerCanvas.width;
        visualizerCtx.fillRect(x - 2, 0, 4, visualizerCanvas.height);
      }

      const now = performance.now();
      const peakFreq = (peakBin * sampleRate) / analyser.fftSize;

      if (maxEnergy > 130) {
        if (machineState === "WAIT_PREAMBLE") {
          if (Math.abs(peakFreq - START_TONE) < 45) {
            machineState = "WAIT_DIGIT";
            detectedDigits = [];
            lastValidDetectionTime = now;
            listenBtnText.innerText = "Locked! Syncing...";
          }
        } else if (machineState === "WAIT_DIGIT") {
          let matched = -1;
          for (let d = 0; d <= 9; d++) {
            const target = FREQ_BASE + (d * FREQ_STEP);
            if (Math.abs(peakFreq - target) < 45) {
              matched = d;
              break;
            }
          }

          if (matched !== -1 && (now - lastValidDetectionTime > 80)) {
            detectedDigits.push(matched);
            lastValidDetectionTime = now;
            listenBtnText.innerText = `Receiving: ${detectedDigits.join("")}`;

            if (detectedDigits.length === 6) {
              const finalPin = detectedDigits.join("");
              listenBtnText.innerText = `PIN: ${finalPin}!`;
              stopListeningAudio();
              connectToPeer(finalPin);
              return;
            }
            machineState = "WAIT_SEPARATOR";
          }
        } else if (machineState === "WAIT_SEPARATOR") {
          if (Math.abs(peakFreq - SEPARATOR_TONE) < 50 && (now - lastValidDetectionTime > 70)) {
            machineState = "WAIT_DIGIT";
            lastValidDetectionTime = now;
          }
        }
      }

      if (machineState !== "WAIT_PREAMBLE" && (now - lastValidDetectionTime > 4000)) {
        machineState = "WAIT_PREAMBLE";
        detectedDigits = [];
        listenBtnText.innerText = "Listen for Sound PIN";
      }

      listenAnimId = requestAnimationFrame(detectLoop);
    }

    detectLoop();
  } catch (err) {
    alert("Microphone permission is required for sound pairing.");
    stopListeningAudio();
  }
});

function stopListeningAudio() {
  isListening = false;
  if (listenStream) {
    listenStream.getTracks().forEach((t) => t.stop());
    listenStream = null;
  }
  if (listenAnimId) cancelAnimationFrame(listenAnimId);
  visualizerCanvas.style.display = "none";
  listenBtnText.innerText = "Listen for Sound PIN";
  listenSoundBtn.style.borderColor = "var(--border-strong)";
}

connectPinBtn.addEventListener("click", () => {
  connectToPeer(manualPinInput.value.trim());
});

feedbackForm.addEventListener("submit", async (e) => {
  e.preventDefault();

  const name = document.getElementById("feedbackName").value.trim() || "Anonymous User";
  const email = document.getElementById("feedbackEmail").value.trim();
  const category = document.getElementById("feedbackCategory").value;
  const message = document.getElementById("feedbackMessage").value.trim();

  if (!email || !message) return alert("Please fill all required fields.");

  feedbackSubmitBtn.disabled = true;
  feedbackBtnText.innerText = "Sending...";

  try {
    const response = await fetch("https://formspree.io/f/xbjnqzzw", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json" },
      body: JSON.stringify({
        name: name,
        email: email,
        category: category,
        message: message,
        developer_email: "vikram.2872006@gmail.com",
        conduit_pin: myPin || "N/A",
        timestamp: new Date().toISOString()
      })
    });

    if (response.ok) {
      feedbackForm.reset();
      feedbackSuccessBanner.style.display = "flex";
      feedbackBtnText.innerText = "✓ Sent Successfully";
      setTimeout(() => {
        feedbackSubmitBtn.disabled = false;
        feedbackBtnText.innerText = "Submit Feedback";
      }, 4000);
    } else {
      window.location.href = `mailto:vikram.2872006@gmail.com?subject=${encodeURIComponent(`[AirShare Feedback] ${category} from${name}`)}&body=${encodeURIComponent(`Name: ${name}\nEmail:${email}\nCategory: ${category}\n\nMessage:\n${message}`)}`;
      feedbackSuccessBanner.style.display = "flex";
      feedbackSubmitBtn.disabled = false;
      feedbackBtnText.innerText = "Submit Feedback";
    }
  } catch (err) {
    window.location.href = `mailto:vikram.2872006@gmail.com?subject=${encodeURIComponent(`[AirShare Feedback] ${category} from${name}`)}&body=${encodeURIComponent(`Name: ${name}\nEmail:${email}\nCategory: ${category}\n\nMessage:\n${message}`)}`;
    feedbackSuccessBanner.style.display = "flex";
    feedbackSubmitBtn.disabled = false;
    feedbackBtnText.innerText = "Submit Feedback";
  }
});

// Background particle animation
const bgCanvas = document.getElementById('bgCanvas');
const bgCtx = bgCanvas.getContext('2d');
const cursorGlow = document.getElementById('cursorGlow');
let particles = [];

function resizeCanvas() {
  bgCanvas.width = window.innerWidth;
  bgCanvas.height = window.innerHeight;
}
window.addEventListener('resize', resizeCanvas);
resizeCanvas();

window.addEventListener('mousemove', (e) => {
  if (cursorGlow) {
    cursorGlow.style.left = e.clientX + 'px';
    cursorGlow.style.top = e.clientY + 'px';
  }
});

class Particle {
  constructor() {
    this.x = Math.random() * bgCanvas.width;
    this.y = Math.random() * bgCanvas.height;
    this.vx = (Math.random() - 0.5) * 0.35;
    this.vy = (Math.random() - 0.5) * 0.35;
    this.radius = Math.random() * 1.2 + 0.5;
  }
  update() {
    this.x += this.vx;
    this.y += this.vy;
    if (this.x < 0 || this.x > bgCanvas.width) this.vx *= -1;
    if (this.y < 0 || this.y > bgCanvas.height) this.vy *= -1;
  }
  draw() {
    bgCtx.beginPath();
    bgCtx.arc(this.x, this.y, this.radius, 0, Math.PI * 2);
    const isLight = document.documentElement.getAttribute('data-theme') === 'light';
    bgCtx.fillStyle = isLight ? 'rgba(56, 189, 248, 0.45)' : 'rgba(41, 151, 255, 0.6)';
    bgCtx.fill();
  }
}

for (let i = 0; i < (window.innerWidth < 600 ? 16 : 32); i++) particles.push(new Particle());

function animateBg() {
  bgCtx.clearRect(0, 0, bgCanvas.width, bgCanvas.height);
  for (let i = 0; i < particles.length; i++) {
    particles[i].update();
    particles[i].draw();
  }
  requestAnimationFrame(animateBg);
}
animateBg();

function toggleTheme() {
  const html = document.documentElement;
  const newTheme = html.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
  html.setAttribute('data-theme', newTheme);
  document.querySelector('#themeToggleBtn i').className = newTheme === 'dark' ? 'fa-solid fa-moon' : 'fa-solid fa-sun';
}

window.addEventListener("DOMContentLoaded", initConduit);