const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] },
    maxHttpBufferSize: 1e8 // 100 MB buffer
});

const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ extended: true, limit: '100mb' }));
app.use(express.static(path.join(__dirname)));

const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => {
        const safeName = file.originalname.replace(/[^a-zA-Z0-9.-]/g, '_');
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, `${uniqueSuffix}-${safeName}`);
    }
});

const upload = multer({ storage: storage, limits: { fileSize: 500 * 1024 * 1024 } });

// In-Memory Database for active vaults
const vaultStore = {};

// Helper: Delete files from disk & memory
function purgeVault(pin) {
    if (vaultStore[pin]) {
        if (vaultStore[pin].timer) clearTimeout(vaultStore[pin].timer);
        vaultStore[pin].files.forEach(file => {
            const filePath = path.join(uploadDir, file.filename);
            if (fs.existsSync(filePath)) {
                fs.unlink(filePath, err => {
                    if (err) console.error(`[PURGE ERROR] ${file.filename}:`, err);
                });
            }
        });
        delete vaultStore[pin];
        console.log(`[PURGED] Vault PIN ${pin} permanently wiped.`);
    }
}

// ==========================================
// 1. UPLOAD ENDPOINT (MULTIPLE FILES)
// ==========================================
app.post('/upload', upload.array('files'), (req, res) => {
    try {
        if (!req.files || req.files.length === 0) {
            return res.status(400).json({ success: false, message: "No files selected." });
        }

        const mode = req.body.mode || 'air'; // 'air', 'sound', or 'gravity'
        
        let pin;
        do {
            pin = Math.floor(100000 + Math.random() * 900000).toString();
        } while (vaultStore[pin]);

        // Lifespan: AirShare = 120s, SoundWave = 60s, GravityDrop = 60s
        const expiryDuration = (mode === 'sound' || mode === 'gravity') ? 60 : 120;

        const expiryTimer = setTimeout(() => {
            purgeVault(pin);
        }, expiryDuration * 1000);

        vaultStore[pin] = {
            files: req.files.map((f, index) => ({
                index: index,
                originalname: f.originalname,
                filename: f.filename,
                size: f.size,
                mimetype: f.mimetype
            })),
            mode: mode,
            downloadCount: 0,
            maxDownloads: 3, // AirShare strictly allows 3 downloads max
            timer: expiryTimer,
            expiresInSeconds: expiryDuration
        };

        console.log(`[VAULT CREATED] Mode: ${mode} | PIN: ${pin} | Files: ${req.files.length} | TTL: ${expiryDuration}s`);

        return res.json({
            success: true,
            pin: pin,
            expiresInSeconds: expiryDuration,
            files: vaultStore[pin].files
        });

    } catch (err) {
        console.error("Upload error:", err);
        return res.status(500).json({ success: false, message: "Server error during upload." });
    }
});

// ==========================================
// 2. METADATA & STREAM DOWNLOAD
// ==========================================
app.get('/api/files/:pin', (req, res) => {
    const pin = req.params.pin.trim();
    const session = vaultStore[pin];

    if (!session) {
        return res.status(404).json({ success: false, message: "PIN/QR is invalid or expired." });
    }

    return res.json({
        success: true,
        files: session.files,
        downloadsRemaining: session.maxDownloads - session.downloadCount
    });
});

// Single File Download Route (Tracks 3 downloads limit)
app.get('/download/:pin/:fileIndex', (req, res) => {
    const { pin, fileIndex } = req.params;
    const session = vaultStore[pin];

    if (!session) {
        return res.status(404).send("Vault session has expired or been deleted.");
    }

    const fileRecord = session.files.find(f => f.index == fileIndex);
    if (!fileRecord) {
        return res.status(404).send("File index not found.");
    }

    const targetPath = path.join(uploadDir, fileRecord.filename);
    if (!fs.existsSync(targetPath)) {
        return res.status(404).send("Physical file was already purged.");
    }

    // If downloading the last file in the bundle, increment download batch count
    if (fileIndex == session.files.length - 1) {
        session.downloadCount += 1;
        console.log(`[DOWNLOAD COMPLETED] PIN: ${pin} | Usage: ${session.downloadCount}/${session.maxDownloads}`);

        // Limit reached: Purge immediately
        if (session.downloadCount >= session.maxDownloads) {
            setTimeout(() => {
                purgeVault(pin);
            }, 1500); // 1.5s grace time to finish the last stream
        }
    }

    return res.download(targetPath, fileRecord.originalname);
});

// ==========================================
// 3. SOCKET.IO ENGINE
// ==========================================
io.on('connection', socket => {
    socket.on('gravity_file_transfer', data => {
        socket.broadcast.emit('receive_gravity_file', data);
    });

    socket.on('sound_token_relay', data => {
        socket.broadcast.emit('receive_sound_token', data);
    });
});

app.use((req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

server.listen(PORT, () => {
    console.log(`Air share pro Server listening on port ${PORT}`);
});