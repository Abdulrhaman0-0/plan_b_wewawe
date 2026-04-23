require('dotenv').config();

const express = require('express');
const http = require('http');
const path = require('path');
const { WebSocketServer } = require('ws');

// ── Config ────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const DASHBOARD_USER = process.env.DASHBOARD_USER || 'admin';
const DASHBOARD_PASS = process.env.DASHBOARD_PASS || 'admin123';

// ── Express (serves React build) ──────────────────────────────────────
const app = express();
const server = http.createServer(app);

const FRONTEND_DIR = path.join(__dirname, '..', 'frontend', 'dist');
app.use(express.static(FRONTEND_DIR));
app.get('*', (_req, res) => {
    res.sendFile(path.join(FRONTEND_DIR, 'index.html'));
});

// ── WebSocket ─────────────────────────────────────────────────────────
const wss = new WebSocketServer({ server });

// All currently authenticated sockets
const authenticatedClients = new Set();

/**
 * Broadcast a message to every authenticated client EXCEPT the sender.
 */
function broadcast(senderWs, payload) {
    const data = JSON.stringify(payload);
    for (const client of authenticatedClients) {
        if (client !== senderWs && client.readyState === client.OPEN) {
            client.send(data);
        }
    }
}

wss.on('connection', (ws) => {
    console.log('🔌  New WebSocket connection');

    let authenticated = false;

    ws.on('message', (raw) => {
        let msg;
        try { msg = JSON.parse(raw); } catch {
            ws.send(JSON.stringify({ type: 'error', message: 'Invalid JSON' }));
            return;
        }

        // ── Authentication ────────────────────────────────────────────────
        if (msg.type === 'auth') {
            const { username, password } = msg.data || {};
            if (username === DASHBOARD_USER && password === DASHBOARD_PASS) {
                authenticated = true;
                authenticatedClients.add(ws);

                ws.send(JSON.stringify({ type: 'auth_ok', message: 'Authenticated' }));
                console.log(`🔑  "${username}" authenticated (${authenticatedClients.size} clients connected)`);
            } else {
                ws.send(JSON.stringify({ type: 'auth_fail', message: 'Invalid credentials' }));
                console.log(`🚫  Auth failed for "${username}"`);
            }
            return;
        }

        // ── Require authentication for all other messages ─────────────────
        if (!authenticated) {
            ws.send(JSON.stringify({ type: 'error', message: 'Not authenticated' }));
            return;
        }

        // ── Telemetry (Pi → relay to all dashboards) ──────────────────────
        if (msg.type === 'telemetry') {
            broadcast(ws, msg);
            return;
        }

        // ── Manual command (dashboard → relay to Pi) ──────────────────────
        if (msg.type === 'manual_cmd') {
            console.log(`🎮  manual_cmd: ${msg.data?.direction || 'stop'}`);
            broadcast(ws, msg);
            ws.send(JSON.stringify({
                type: 'cmd_ack',
                message: `Command relayed to UGV`,
            }));
            return;
        }

        // ── Emergency Stop (dashboard → relay to Pi) ──────────────────────
        if (msg.type === 'emergency_stop') {
            console.log(`🚨  emergency_stop received — Relaying to UGV!`);
            broadcast(ws, msg);
            ws.send(JSON.stringify({
                type: 'cmd_ack',
                message: `E-STOP relayed to UGV`,
            }));
            return;
        }

        // Ignore or acknowledge unknown messages (such as navigation payloads from dashboard that are no longer supported)
    });

    ws.on('close', () => {
        authenticatedClients.delete(ws);
        console.log(`🔌  Client disconnected (${authenticatedClients.size} remaining)`);
    });

    ws.on('error', (err) => console.error('WS error:', err.message));
});

// ── Start server ──────────────────────────────────────────────────────
server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀  UGV Dashboard static + WS proxy server running on port ${PORT}`);
});
