const { 
    default: makeWASocket, 
    useMultiFileAuthState, 
    DisconnectReason 
} = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const express = require('express');
const cors = require('cors');
const pino = require('pino');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

let sock;
let isConnected = false;

async function startWhatsApp() {
    // 1. Initialize local file auth state (stores JSON keys inside ./.baileys_auth)
    const { state, saveCreds } = await useMultiFileAuthState('.baileys_auth');

    // 2. Create the Baileys WebSocket connection
    sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: 'silent' })
    });

    // Automatically save updated session keys
    sock.ev.on('creds.update', saveCreds);

    // 3. Handle connection status updates
    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            console.log('\n========================================');
            console.log('SCAN THIS QR CODE IN YOUR PHONE (LINKED DEVICES):');
            console.log('========================================\n');
            qrcode.generate(qr, { small: true });
        }

        if (connection === 'close') {
            isConnected = false;
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

            console.log(`Connection closed (Reason: ${statusCode}). Reconnecting: ${shouldReconnect}`);
            if (shouldReconnect) {
                setTimeout(startWhatsApp, 3000);
            } else {
                console.log('Session logged out. Delete the .baileys_auth folder to generate a new QR.');
            }
        } else if (connection === 'open') {
            isConnected = true;
            console.log('✅ WhatsApp Baileys Socket is active and ready!');
        }
    });

    // 4. Message Handler Example
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type === 'notify') {
            for (const msg of messages) {
                if (!msg.key.fromMe && msg.message) {
                    const body = msg.message.conversation || msg.message.extendedTextMessage?.text;
                    if (body?.toLowerCase() === '!ping') {
                        await sock.sendMessage(msg.key.remoteJid, { text: 'pong!' });
                    }
                }
            }
        }
    });
}

// Helper to format numbers (e.g., 15551234567@s.whatsapp.net)
function formatJid(number) {
    let cleaned = number.replace(/\D/g, '');
    if (!cleaned.endsWith('@s.whatsapp.net')) {
        cleaned = `${cleaned}@s.whatsapp.net`;
    }
    return cleaned;
}

// API Routes
app.get('/status', (req, res) => {
    res.json({ status: isConnected ? 'connected' : 'disconnected' });
});

app.post('/send-message', async (req, res) => {
    const { number, message } = req.body;

    if (!isConnected) {
        return res.status(503).json({ status: 'error', message: 'WhatsApp client is not ready.' });
    }

    if (!number || !message) {
        return res.status(400).json({ status: 'error', message: 'Fields "number" and "message" are required.' });
    }

    try {
        const jid = formatJid(number);
        const sent = await sock.sendMessage(jid, { text: message });
        return res.json({ status: 'success', messageId: sent.key.id });
    } catch (error) {
        console.error('Failed to send message:', error);
        return res.status(500).json({ status: 'error', error: error.message });
    }
});

app.listen(PORT, () => {
    console.log(`🌐 Server running on http://localhost:${PORT}`);
    startWhatsApp();
});
