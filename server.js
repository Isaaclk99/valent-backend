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

// Allow your Vercel frontend to talk to this server
app.use(cors({
    origin: "https://pluseconnect.netlify.app",
    methods: ["GET", "POST"],
    credentials: true
}));
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "https://pluseconnect.netlify.app",
        methods: ["GET", "POST"],
        credentials: true
    },
    transports: ['websocket', 'polling'] // Allow fallback if websocket fails
});

app.get('/', (req, res) => res.send("Server is running! ❤️"));

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

io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    socket.on('join-room', (room) => {
        const roomUpper = room.toUpperCase();
        socket.join(roomUpper);

        const clients = io.sockets.adapter.rooms.get(roomUpper);
        const count = clients ? clients.size : 0;

        // Notify both users that partner is present if count >= 2
        io.to(roomUpper).emit('update-ui', { isPartnerPresent: count >= 2 });
    });

    socket.on('send-pulse', async ({ roomId, x, y }) => {
        const roomUpper = roomId.toUpperCase();
        socket.to(roomUpper).emit('receive-pulse', { x, y });
        try {
            const result = await pool.query(
                'UPDATE couples SET pulse_count = pulse_count + 1 WHERE room_code = $1 RETURNING pulse_count',
                [roomUpper]
            );
            io.to(roomUpper).emit('update-count', result.rows[0].pulse_count);
        } catch (err) { console.error("Pulse update failed"); }
    });

    socket.on('send-gift', ({ roomId, emoji }) => {
        io.to(roomId.toUpperCase()).emit('receive-gift', { emoji });
    });

    socket.on('disconnecting', () => {
        for (const room of socket.rooms) {
            if (room !== socket.id) {
                socket.to(room).emit('update-ui', { isPartnerPresent: false });
            }
        }
    });
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => console.log(`Backend live on port ${PORT}`));
