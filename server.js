const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);

// 100 MB buffer limit for large files & base64 streams
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    },
    maxHttpBufferSize: 1e8 
});

const PORT = process.env.PORT || 3000;

// Middlewares
app.use(cors());
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ extended: true, limit: '100mb' }));

// Serve frontend assets directly
app.use(express.static(path.join(__dirname)));

// Ensure temporary upload directory exists
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}

// Multer Storage Configuration
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
        const safeName = file.originalname.replace(/[^a-zA-Z0-9.-]/g, '_');
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, `${uniqueSuffix}-${safeName}`);
    }
});

const upload = multer({
    storage: storage,
    limits: { fileSize: 500 * 1024 * 1024 } // 500MB payload limit
});

// In-Memory Vault Store for active PINs
const vaultStore = {};

// ==========================================
// 1. AIR-SHARE & SOUND-WAVE REST APIs
// ==========================================

// Upload files and generate 6-digit PIN with a 120-second lifespan
app.post('/upload', upload.array('files'), (req, res) => {
    try {
        if (!req.files || req.files.length === 0) {
            return res.status(400).json({ success: false, message: "No files uploaded." });
        }

        let pin;
        do {
            pin = Math.floor(100000 + Math.random() * 900000).toString();
        } while (vaultStore[pin]);

        // Auto-purge vault after 120 seconds (2 minutes)
        const expiryTimer = setTimeout(() => {
            if (vaultStore[pin]) {
                vaultStore[pin].files.forEach(file => {
                    const filePath = path.join(uploadDir, file.filename);
                    if (fs.existsSync(filePath)) {
                        fs.unlink(filePath, (err) => {
                            if (err) console.error(`[PURGE ERROR] ${file.filename}:`, err);
                        });
                    }
                });

                delete vaultStore[pin];
                console.log(`[EXPIRED] PIN ${pin} destroyed & wiped from disk.`);
            }
        }, 120 * 1000);

        vaultStore[pin] = {
            files: req.files.map((f, index) => ({
                index: index,
                originalname: f.originalname,
                filename: f.filename,
                size: f.size,
                mimetype: f.mimetype
            })),
            timer: expiryTimer,
            createdAt: Date.now()
        };

        console.log(`[VAULT ARMED] PIN: ${pin} (${req.files.length} file(s))`);

        return res.json({
            success: true,
            pin: pin,
            expiresInSeconds: 120
        });

    } catch (error) {
        console.error("[UPLOAD EXCEPTION]:", error);
        return res.status(500).json({ success: false, message: "Internal server staging error." });
    }
});

// Resolve file list by PIN (Used by Air-Share QR/PIN retrieval & Sound-Wave token resolve)
app.get('/api/files/:pin', (req, res) => {
    const pin = req.params.pin.trim();
    const session = vaultStore[pin];

    if (!session) {
        return res.status(404).json({
            success: false,
            message: "PIN is invalid or vault has expired (120s limit reached)."
        });
    }

    return res.json({
        success: true,
        files: session.files
    });
});

// Stream file download by PIN and index
app.get('/download/:pin/:fileIndex', (req, res) => {
    const { pin, fileIndex } = req.params;
    const session = vaultStore[pin];

    if (!session) {
        return res.status(404).send("Session expired or invalid.");
    }

    const fileRecord = session.files.find(f => f.index == fileIndex);
    if (!fileRecord) {
        return res.status(404).send("Requested file index not found.");
    }

    const targetPath = path.join(uploadDir, fileRecord.filename);
    if (!fs.existsSync(targetPath)) {
        return res.status(404).send("Physical file was already purged.");
    }

    return res.download(targetPath, fileRecord.originalname);
});

// ==========================================
// 2. REAL-TIME SOCKET.IO ENGINE
// ==========================================
io.on('connection', (socket) => {
    console.log(`[CLIENT CONNECTED] ID: ${socket.id}`);

    // Gravity-Drop: Broadcast phone tilt stream to connected laptops/catch-decks
    socket.on('gravity_file_transfer', (payload) => {
        console.log(`[GRAVITY TRANSFER] Received: ${payload.filename}`);
        socket.broadcast.emit('receive_gravity_file', payload);
    });

    // Sound-Wave: Relay acoustic token transmissions between peer sessions
    socket.on('sound_token_relay', (data) => {
        console.log(`[SOUND RELAY] Token broadcast: ${data.token || data.pin}`);
        socket.broadcast.emit('receive_sound_token', data);
    });

    socket.on('disconnect', () => {
        console.log(`[CLIENT DISCONNECTED] ID: ${socket.id}`);
    });
});

// Single Page Application Fallback
app.use((req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Start Server
server.listen(PORT, () => {
    console.log(`===============================================`);
    console.log(` Air share pro Core Server Running!`);
    console.log(` Endpoint:   http://localhost:${PORT}`);
    console.log(` Modules:    Air-Share | Sound-Wave | Gravity-Drop`);
    console.log(` Lifespan:   120s Ephemeral Auto-Purge`);
    console.log(`===============================================`);
});