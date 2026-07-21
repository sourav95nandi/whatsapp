const { 
    default: makeWASocket, 
    useMultiFileAuthState, 
    DisconnectReason,
    fetchLatestBaileysVersion,
    Browsers
} = require('@whiskeysockets/baileys');
const qrcodeTerminal = require('qrcode-terminal');
const QRCode = require('qrcode');
const express = require('express');
const cors = require('cors');
const pino = require('pino');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

let sock;
let isConnected = false;
let qrCodeUrl = null;

async function startWhatsApp() {
    // 1. Fetch latest WhatsApp Web version to prevent protocol rejection
    const { version, isLatest } = await fetchLatestBaileysVersion();
    console.log(`🔄 Using WhatsApp Web v${version.join('.')} (isLatest: ${isLatest})`);

    // 2. Load auth state from .baileys_auth folder
    const { state, saveCreds } = await useMultiFileAuthState('.baileys_auth');

    // 3. Create socket connection simulating a desktop Chrome browser
    sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: 'silent' }),
        browser: Browsers.macOS('Desktop'), // Simulates desktop browser connection
        syncFullHistory: false
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        // Render QR Code as Base64 Image
        if (qr) {
            try {
                qrCodeUrl = await QRCode.toDataURL(qr);
                qrcodeTerminal.generate(qr, { small: true });
            } catch (err) {
                console.error('Failed to render QR Code:', err);
            }
        }

        if (connection === 'close') {
            isConnected = false;
            
            // Extract HTTP status code from Boom error payload
            const statusCode = lastDisconnect?.error?.output?.statusCode || lastDisconnect?.error?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

            console.log(`⚠️ Connection closed. Status Code: ${statusCode}. Reconnecting: ${shouldReconnect}`);

            // Automatically reconnect for temporary drops (including 515 restartRequired)
            if (shouldReconnect) {
                setTimeout(startWhatsApp, 3000);
            } else {
                console.log('❌ Logged out from WhatsApp. Clear .baileys_auth folder and restart.');
                qrCodeUrl = null;
            }
        } else if (connection === 'open') {
            isConnected = true;
            qrCodeUrl = null;
            console.log('✅ WhatsApp connection established successfully!');
        }
    });

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

// --- Serve QR Page at '/' ---
app.get('/', (req, res) => {
    if (isConnected) {
        return res.send(`
            <!DOCTYPE html>
            <html>
            <head><title>WhatsApp Status</title></head>
            <body style="font-family: sans-serif; text-align: center; padding-top: 50px;">
                <h2 style="color: #25D366;">✅ WhatsApp Connected!</h2>
                <p>Your session is online and ready to send messages.</p>
            </body>
            </html>
        `);
    }

    if (qrCodeUrl) {
        return res.send(`
            <!DOCTYPE html>
            <html>
            <head>
                <title>Scan WhatsApp QR Code</title>
                <meta http-equiv="refresh" content="10">
            </head>
            <body style="font-family: sans-serif; text-align: center; padding-top: 50px;">
                <h2>Scan with WhatsApp</h2>
                <p>Open WhatsApp → Linked Devices → Link a Device</p>
                <img src="${qrCodeUrl}" style="width:250px; height:250px;" />
            </body>
            </html>
        `);
    }

    return res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>Loading...</title>
            <meta http-equiv="refresh" content="3">
        </head>
        <body style="font-family: sans-serif; text-align: center; padding-top: 50px;">
            <h2>⏳ Connecting to WhatsApp...</h2>
            <p>Please wait a moment while the socket initializes.</p>
        </body>
        </html>
    `);
});

app.get('/status', (req, res) => {
    res.json({ status: isConnected ? 'connected' : 'disconnected' });
});

app.post('/send-message', async (req, res) => {
    const { number, message } = req.body;

    if (!isConnected) {
        return res.status(503).json({ status: 'error', message: 'WhatsApp client is not connected.' });
    }

    if (!number || !message) {
        return res.status(400).json({ status: 'error', message: 'Fields "number" and "message" are required.' });
    }

    try {
        let cleaned = number.replace(/\D/g, '');
        if (!cleaned.endsWith('@s.whatsapp.net')) {
            cleaned = `${cleaned}@s.whatsapp.net`;
        }
        const sent = await sock.sendMessage(cleaned, { text: message });
        return res.json({ status: 'success', messageId: sent.key.id });
    } catch (error) {
        return res.status(500).json({ status: 'error', error: error.message });
    }
});

app.listen(PORT, () => {
    console.log(`🌐 Server running on http://localhost:${PORT}`);
    startWhatsApp();
});
