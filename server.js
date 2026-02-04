require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// 1. DYNAMIC CORS: Replace with your actual Vercel URL
const FRONTEND_URL = "https://pluse-connect.vercel.app";

app.use(cors({
    origin: FRONTEND_URL,
    methods: ["GET", "POST"],
    credentials: true
}));
app.use(express.json());

const server = http.createServer(app);

// 2. MOBILE-STABLE SOCKET CONFIG
const io = new Server(server, {
    cors: {
        origin: FRONTEND_URL,
        methods: ["GET", "POST"],
        credentials: true
    },
    allowEIO3: true,
    pingTimeout: 60000, // Handle mobile signal drops
    transports: ['polling', 'websocket'] // Polling is safer for mobile initialization
});

app.get('/', (req, res) => res.send("Server is running! ❤️"));

// Register Room
app.post('/api/register', async (req, res) => {
    const { roomCode, userA, userB, letterA, letterB, song } = req.body;
    try {
        await pool.query(
            `INSERT INTO couples (room_code, user_a_name, user_b_name, letter_for_a, letter_for_b, selected_song, pulse_count) 
             VALUES ($1, $2, $3, $4, $5, $6, 0)`,
            [roomCode.toUpperCase(), userA, userB, letterA, letterB, song]
        );
        res.json({ success: true });
    } catch (err) { res.status(400).json({ error: "Room already exists" }); }
});

// Login
app.post('/api/login', async (req, res) => {
    const { roomCode, myName } = req.body;
    try {
        const result = await pool.query('SELECT * FROM couples WHERE room_code = $1', [roomCode.toUpperCase()]);
        if (result.rows.length === 0) return res.status(404).json({ error: "Room not found" });

        const couple = result.rows[0];
        let letter = (myName.toLowerCase() === couple.user_a_name.toLowerCase()) ? couple.letter_for_a : couple.letter_for_b;
        res.json({ letter, song: couple.selected_song, pulseCount: couple.pulse_count });
    } catch (err) { res.status(500).json({ error: "Database error" }); }
});

// Socket Events
io.on('connection', (socket) => {
    socket.on('join-room', (room) => {
        const roomUpper = room.toUpperCase();
        socket.join(roomUpper);

        const clients = io.sockets.adapter.rooms.get(roomUpper);
        const count = clients ? clients.size : 0;

        // Sync partner status to everyone in room
        io.to(roomUpper).emit('update-ui', { isPartnerPresent: count >= 2 });
    });

    socket.on('send-pulse', async ({ roomId, x, y }) => {
        const roomUpper = roomId.toUpperCase();
        // Send to everyone EXCEPT the sender
        socket.to(roomUpper).emit('receive-pulse', { x, y });

        try {
            const result = await pool.query(
                'UPDATE couples SET pulse_count = pulse_count + 1 WHERE room_code = $1 RETURNING pulse_count',
                [roomUpper]
            );
            // Broadcast new count to BOTH users
            io.to(roomUpper).emit('update-count', result.rows[0].pulse_count);
        } catch (err) { console.error("Pulse update failed"); }
    });

    socket.on('send-gift', ({ roomId, emoji }) => {
        io.to(roomId.toUpperCase()).emit('receive-gift', { emoji });
    });

    socket.on('disconnecting', () => {
        socket.rooms.forEach(room => {
            if (room !== socket.id) {
                // Delay the "Partner Left" message slightly to prevent flickering on mobile page refresh
                setTimeout(() => {
                    const clients = io.sockets.adapter.rooms.get(room);
                    const count = clients ? clients.size : 0;
                    if (count < 2) {
                        socket.to(room).emit('update-ui', { isPartnerPresent: false });
                    }
                }, 1000);
            }
        });
    });
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => console.log(`Backend live on port ${PORT}`));
