let myPin = "";
let peer = null;
let dataConn = null;
let audioCtx = null;
let isListening = false;
let listenStream = null;
let listenAnimId = null;

// Audio Configuration (Acoustic FSK with Clock Separator)
const START_TONE = 1450;
const SEPARATOR_TONE = 1700;
const FREQ_BASE = 2000;
const FREQ_STEP = 150;
const DIGIT_DURATION = 0.16;
const SYNC_DURATION = 0.10;

// High-speed Chunking Engine
const CHUNK_SIZE = 128 * 1024; // 128KB chunks
const BUFFER_MAX_THRESHOLD = 4 * 1024 * 1024; // 4MB threshold

// Transfer Control States
let isTransferAborted = false;
let currentTransferId = null;
let transferStartTime = 0;
let lastProgressSentTime = 0;
let bytesSamplePeriod = 0;

// Receiver State
let incomingFileMeta = null;
let incomingFileChunks = [];
let incomingBytesReceived = 0;

// In-memory Blobs Storage
const fileBlobsMap = new Map();

// DOM Elements
const pinBox = document.getElementById("pinBox");
const qrcodeContainer = document.getElementById("qrcode");
const statusText = document.getElementById("statusText");
const statusDot = document.getElementById("statusDot");
const pairingSection = document.getElementById("pairingSection");
const transferSection = document.getElementById("transferSection");
const emitSoundBtn = document.getElementById("emitSoundBtn");
const listenSoundBtn = document.getElementById("listenSoundBtn");
const listenStatus = document.getElementById("listenStatus");
const manualPinInput = document.getElementById("manualPinInput");
const connectPinBtn = document.getElementById("connectPinBtn");
const disconnectBtn = document.getElementById("disconnectBtn");
const clipboardArea = document.getElementById("clipboardArea");
const pasteDeviceBtn = document.getElementById("pasteDeviceBtn");
const copyDeviceBtn = document.getElementById("copyDeviceBtn");
const copyBtnLabel = document.getElementById("copyBtnLabel");
const fileInput = document.getElementById("fileInput");

// Metrics Dashboard DOM (SENDER ONLY)
const transferMetricsCard = document.getElementById("transferMetricsCard");
const transferFileName = document.getElementById("transferFileName");
const transferSpeed = document.getElementById("transferSpeed");
const transferETA = document.getElementById("transferETA");
const transferBytesRatio = document.getElementById("transferBytesRatio");
const transferPercent = document.getElementById("transferPercent");
const progressBar = document.getElementById("progressBar");
const cancelTransferBtn = document.getElementById("cancelTransferBtn");

// Receiver Notice Banner
const receiverNoticeBanner = document.getElementById("receiverNoticeBanner");
const receivingNoticeName = document.getElementById("receivingNoticeName");

const sessionFilesList = document.getElementById("sessionFilesList");
const visualizerCanvas = document.getElementById("visualizerCanvas");
const visualizerCtx = visualizerCanvas.getContext("2d");

lucide.createIcons();

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
  const minutes = now.getMinutes().toString().padStart(2, '0');
  const ampm = hours >= 12 ? 'PM' : 'AM';
  hours = hours % 12 || 12;
  return `${hours}:${minutes} ${ampm}`;
}

function generatePIN() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

function initHost() {
  const hashParams = new URLSearchParams(window.location.hash.substring(1));
  const targetPin = hashParams.get("pin");

  myPin = generatePIN();
  pinBox.innerText = myPin;

  qrcodeContainer.innerHTML = "";
  const joinUrl = `${window.location.origin}/#pin=${myPin}`;
  new QRCode(qrcodeContainer, {
    text: joinUrl,
    width: 128,
    height: 128,
    colorDark: "#020617",
    colorLight: "#ffffff",
    correctLevel: QRCode.CorrectLevel.M
  });

  peer = new Peer(`sonicdrop-${myPin}`, {
    host: window.location.hostname,
    port: window.location.port || (window.location.protocol === "https:" ? 443 : 80),
    path: "/peerjs",
    secure: window.location.protocol === "https:"
  });

  peer.on("open", () => {
    statusText.innerText = "Ready";
    statusDot.classList.replace("bg-amber-400", "bg-emerald-400");
    if (targetPin && targetPin !== myPin) {
      connectToPeer(targetPin);
    }
  });

  peer.on("connection", (conn) => {
    setupDataConnection(conn);
  });
}

function connectToPeer(targetPin) {
  if (!targetPin || targetPin.length !== 6) return alert("Enter valid 6-digit PIN");
  statusText.innerText = `Connecting to ${targetPin}...`;
  const conn = peer.connect(`sonicdrop-${targetPin}`, { reliable: true });
  setupDataConnection(conn);
}

function setupDataConnection(conn) {
  dataConn = conn;

  dataConn.on("open", () => {
    stopListeningAudio();
    pairingSection.classList.add("hidden");
    transferSection.classList.remove("hidden");
    document.getElementById("peerStatusLabel").innerText = `Connected with Peer`;
  });

  dataConn.on("data", (data) => {
    // 1. Control / Metadata JSON
    if (typeof data === "string") {
      try {
        const msg = JSON.parse(data);

        if (msg.type === "clipboard") {
          clipboardArea.value = msg.text;
        } 
        else if (msg.type === "file-start") {
          incomingFileMeta = msg;
          incomingFileChunks = [];
          incomingBytesReceived = 0;
          currentTransferId = msg.transferId;
          isTransferAborted = false;

          // Progress card stays hidden on Receiver side
          transferMetricsCard.classList.add("hidden");

          // Show subtle notice banner for Receiver
          receivingNoticeName.innerText = msg.name;
          receiverNoticeBanner.classList.remove("hidden");
        }
        else if (msg.type === "file-abort") {
          alert(`Transfer of "${incomingFileMeta ? incomingFileMeta.name : 'File'}" was canceled by Sender.`);
          resetTransferUI();
        }
        else if (msg.type === "file-delete") {
          const item = document.getElementById(`file-item-${msg.fileId}`);
          if (item) item.remove();
          fileBlobsMap.delete(msg.fileId);
          checkEmptyHistory();
        }
        else if (msg.type === "file-end") {
          receiverNoticeBanner.classList.add("hidden");

          if (incomingFileMeta && !isTransferAborted) {
            const transferId = incomingFileMeta.transferId;
            const fileName = incomingFileMeta.name;
            const fileSize = incomingFileMeta.size;
            const fileTime = incomingFileMeta.time;
            const mime = incomingFileMeta.mime || "application/octet-stream";
            
            // Build safe binary Blob
            const safeBlob = new Blob(incomingFileChunks, { type: mime });
            
            // In-memory reference
            fileBlobsMap.set(transferId, {
              blob: safeBlob,
              name: fileName
            });

            // Add to session history
            renderFileInHistory(fileName, fileSize, transferId, false, fileTime);

            // AUTO DOWNLOAD TRIGGER: Receive hote hi automatically download kar do!
            triggerFileDownload(transferId);

            incomingFileMeta = null;
            incomingFileChunks = [];
          }
        }
      } catch (e) {
        console.error("Control error:", e);
      }
    } 
    // 2. Binary Chunk Handling
    else {
      if (!incomingFileMeta || isTransferAborted) return;

      if (data instanceof ArrayBuffer) {
        incomingFileChunks.push(data);
        incomingBytesReceived += data.byteLength;
      } else if (ArrayBuffer.isView(data)) {
        incomingFileChunks.push(data.buffer);
        incomingBytesReceived += data.byteLength;
      } else if (data instanceof Blob) {
        data.arrayBuffer().then((buf) => {
          incomingFileChunks.push(buf);
          incomingBytesReceived += buf.byteLength;
        });
      }
    }
  });

  dataConn.on("close", () => location.reload());
}

function resetTransferUI() {
  transferMetricsCard.classList.add("hidden");
  receiverNoticeBanner.classList.add("hidden");
  incomingFileMeta = null;
  incomingFileChunks = [];
  incomingBytesReceived = 0;
  isTransferAborted = false;
  currentTransferId = null;
}

// Live Clipboard
clipboardArea.addEventListener("input", (e) => {
  if (dataConn && dataConn.open) {
    dataConn.send(JSON.stringify({ type: "clipboard", text: e.target.value }));
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
    alert("Clipboard read access needed.");
  }
});

copyDeviceBtn.addEventListener("click", async () => {
  await navigator.clipboard.writeText(clipboardArea.value);
  copyBtnLabel.innerText = "Copied!";
  setTimeout(() => (copyBtnLabel.innerText = "Copy to Clipboard"), 1200);
});

// File Streaming (Sender)
fileInput.addEventListener("change", (e) => {
  const files = Array.from(e.target.files);
  if (!files.length || !dataConn || !dataConn.open) return;
  files.forEach(sendFileStream);
  fileInput.value = "";
});

// Cancel Button Action (Sender)
cancelTransferBtn.addEventListener("click", () => {
  if (confirm("Cancel this file transfer?")) {
    isTransferAborted = true;
    if (dataConn && dataConn.open) {
      dataConn.send(JSON.stringify({ type: "file-abort", transferId: currentTransferId }));
    }
    resetTransferUI();
  }
});

function sendFileStream(file) {
  isTransferAborted = false;
  currentTransferId = "file-" + Date.now();
  const fileTime = getCurrentTimeStr();

  // Show progress card ONLY FOR SENDER
  transferMetricsCard.classList.remove("hidden");
  transferFileName.innerText = file.name;
  transferBytesRatio.innerText = `0 B / ${formatBytes(file.size)}`;
  transferPercent.innerText = "0%";
  progressBar.style.width = "0%";
  transferSpeed.innerText = "Starting...";
  transferETA.innerText = "ETA: Calculating...";

  lucide.createIcons();

  transferStartTime = performance.now();
  lastProgressSentTime = transferStartTime;
  bytesSamplePeriod = 0;

  // Save blob in sender's local map
  fileBlobsMap.set(currentTransferId, {
    blob: file,
    name: file.name
  });

  // Notify Receiver of File Start with exact Time
  dataConn.send(JSON.stringify({
    type: "file-start",
    transferId: currentTransferId,
    name: file.name,
    size: file.size,
    mime: file.type,
    time: fileTime
  }));

  let offset = 0;
  const channel = dataConn.dataChannel;

  function streamNextChunk() {
    if (isTransferAborted) return;

    if (offset >= file.size) {
      dataConn.send(JSON.stringify({ type: "file-end", transferId: currentTransferId }));
      
      // Render in sender history with time
      renderFileInHistory(file.name, file.size, currentTransferId, true, fileTime);
      setTimeout(resetTransferUI, 800);
      return;
    }

    if (channel.bufferedAmount > BUFFER_MAX_THRESHOLD) {
      setTimeout(streamNextChunk, 20);
      return;
    }

    const chunk = file.slice(offset, offset + CHUNK_SIZE);
    chunk.arrayBuffer().then((buffer) => {
      if (isTransferAborted) return;

      dataConn.send(buffer);
      offset += buffer.byteLength;
      bytesSamplePeriod += buffer.byteLength;

      // Update SENDER UI every ~150ms
      const now = performance.now();
      const timeDiff = (now - lastProgressSentTime) / 1000;

      if (timeDiff >= 0.15 || offset >= file.size) {
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

        transferBytesRatio.innerText = `${formatBytes(offset)} / ${formatBytes(file.size)}`;
        transferPercent.innerText = `${pct}%`;
        progressBar.style.width = `${pct}%`;
        transferSpeed.innerText = speedStr;
        transferETA.innerText = etaStr;

        bytesSamplePeriod = 0;
        lastProgressSentTime = now;
      }

      streamNextChunk();
    });
  }

  streamNextChunk();
}

// Auto & Manual Download Handler
window.triggerFileDownload = function(fileId) {
  const item = fileBlobsMap.get(fileId);
  if (!item || !item.blob) return;

  const { blob, name } = item;

  if (window.navigator && window.navigator.msSaveOrOpenBlob) {
    window.navigator.msSaveOrOpenBlob(blob, name);
    return;
  }

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

// Session Files History with Time & Delete Feature
function renderFileInHistory(name, size, fileId, isSender, timeStr) {
  checkEmptyHistory();

  const item = document.createElement("div");
  item.id = `file-item-${fileId}`;
  item.className = "flex items-center justify-between p-3 bg-slate-950 rounded-xl border border-slate-800 text-xs shadow-md";

  item.innerHTML = `
    <div class="truncate max-w-[150px] sm:max-w-[210px]">
      <div class="font-medium text-slate-200 truncate">${name}</div>
      <div class="text-[10px] text-slate-400 mt-0.5 flex items-center space-x-1.5">
        <span>${formatBytes(size)}</span>
        <span>•</span>
        <span class="${isSender ? 'text-blue-400 font-semibold' : 'text-emerald-400 font-semibold'}">${isSender ? 'Sent' : 'Received'}</span>
        <span>•</span>
        <span class="text-slate-400 font-mono">${timeStr || getCurrentTimeStr()}</span>
      </div>
    </div>
    <div class="flex items-center space-x-1.5 shrink-0">
      <button onclick="triggerFileDownload('${fileId}')" class="px-2.5 py-1.5 bg-emerald-600 hover:bg-emerald-500 rounded-lg text-white font-medium flex items-center space-x-1 transition shadow">
        <i data-lucide="download" class="w-3.5 h-3.5"></i>
        <span>Save</span>
      </button>
      <button onclick="deleteFile('${fileId}')" title="Delete file" class="p-1.5 bg-rose-600/20 hover:bg-rose-600/40 text-rose-400 rounded-lg transition border border-rose-500/20">
        <i data-lucide="trash-2" class="w-3.5 h-3.5"></i>
      </button>
    </div>
  `;

  sessionFilesList.prepend(item);
  lucide.createIcons();
}

window.deleteFile = function(fileId) {
  if (confirm("Delete this file for both devices?")) {
    const item = document.getElementById(`file-item-${fileId}`);
    if (item) item.remove();
    fileBlobsMap.delete(fileId);
    checkEmptyHistory();

    if (dataConn && dataConn.open) {
      dataConn.send(JSON.stringify({ type: "file-delete", fileId: fileId }));
    }
  }
};

function checkEmptyHistory() {
  if (!sessionFilesList.querySelector("div")) {
    sessionFilesList.innerHTML = `<p class="text-xs text-slate-600 italic">No files exchanged yet.</p>`;
  } else if (sessionFilesList.querySelector("p")) {
    sessionFilesList.querySelector("p").remove();
  }
}

// --- Audio Tone Synthesis & Recognition ---
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

  emitSoundBtn.innerText = "Emitting Sound Waves...";
  emitSoundBtn.classList.add("opacity-70", "pointer-events-none");

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
    emitSoundBtn.innerHTML = `<i data-lucide="radio" class="w-5 h-5"></i><span>Emit Sound PIN</span>`;
    emitSoundBtn.classList.remove("opacity-70", "pointer-events-none");
    lucide.createIcons();
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
    visualizerCanvas.classList.remove("hidden");
    listenStatus.innerText = "Listening for sound...";
    listenSoundBtn.classList.add("border-emerald-500", "bg-emerald-950/20");

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

      visualizerCtx.fillStyle = "#020617";
      visualizerCtx.fillRect(0, 0, visualizerCanvas.width, visualizerCanvas.height);
      visualizerCtx.fillStyle = "#10b981";

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
            listenStatus.innerText = "Locked! Reading digits...";
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
            listenStatus.innerText = `Receiving: ${detectedDigits.join("")}`;

            if (detectedDigits.length === 6) {
              const finalPin = detectedDigits.join("");
              listenStatus.innerText = `PIN Verified: ${finalPin}! Connecting...`;
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
        listenStatus.innerText = "Signal timed out. Re-listening...";
      }

      listenAnimId = requestAnimationFrame(detectLoop);
    }

    detectLoop();
  } catch (err) {
    alert("Microphone permission required for audio pairing.");
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
  visualizerCanvas.classList.add("hidden");
  listenSoundBtn.classList.remove("border-emerald-500", "bg-emerald-950/20");
  listenStatus.innerText = "Tap to detect tone frequencies";
}

connectPinBtn.addEventListener("click", () => {
  connectToPeer(manualPinInput.value.trim());
});

disconnectBtn.addEventListener("click", () => {
  if (dataConn) dataConn.close();
  location.reload();
});

window.addEventListener("DOMContentLoaded", initHost);