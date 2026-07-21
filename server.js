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
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json()); // Essential to parse JSON payloads in POST requests

let sock;
let isConnected = false;
let qrCodeUrl = null;

// Helper to clear invalid cache
function clearAuthFolder() {
    const authPath = './.baileys_auth';
    if (fs.existsSync(authPath)) {
        try {
            fs.rmSync(authPath, { recursive: true, force: true });
            console.log('🧹 Purged .baileys_auth session files.');
        } catch (err) {
            console.error('Error clearing folder:', err);
        }
    }
}

async function startWhatsApp() {
    const { version } = await fetchLatestBaileysVersion();
    console.log(`🔄 Using WA Web Version: ${version.join('.')}`);

    const { state, saveCreds } = await useMultiFileAuthState('.baileys_auth');

    sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: 'silent' }),
        browser: Browsers.macOS('Chrome'),
        syncFullHistory: false
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            try {
                qrCodeUrl = await QRCode.toDataURL(qr);
                qrcodeTerminal.generate(qr, { small: true });
            } catch (err) {
                console.error('Failed to generate QR Code:', err);
            }
        }

        if (connection === 'close') {
            isConnected = false;
            qrCodeUrl = null;

            const statusCode = lastDisconnect?.error?.output?.statusCode || lastDisconnect?.error?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

            console.log(`⚠️ Connection closed (Code ${statusCode}). Reconnecting: ${shouldReconnect}`);

            if (shouldReconnect) {
                setTimeout(startWhatsApp, 3000);
            } else {
                console.log('❌ Unlinked or logged out. Resetting auth...');
                clearAuthFolder();
                setTimeout(startWhatsApp, 3000);
            }
        } else if (connection === 'open') {
            isConnected = true;
            qrCodeUrl = null;
            console.log('✅ Connected successfully!');
        }
    });
}

// Format Phone Numbers to JID
function formatJid(number) {
    let cleaned = number.replace(/\D/g, '');
    if (!cleaned.endsWith('@s.whatsapp.net')) {
        cleaned = `${cleaned}@s.whatsapp.net`;
    }
    return cleaned;
}

// --- Express Routes ---

// 1. Dynamic QR Code JSON endpoint
app.get('/qr-data', (req, res) => {
    res.json({
        connected: isConnected,
        qr: qrCodeUrl
    });
});

// 2. Status Route
app.get('/status', (req, res) => {
    res.json({ status: isConnected ? 'connected' : 'disconnected' });
});

// 3. Send Message API Endpoint (Restored)
app.post('/send-message', async (req, res) => {
    const { number, message } = req.body;

    if (!isConnected) {
        return res.status(503).json({ status: 'error', message: 'WhatsApp client is not connected.' });
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

const axios = require('axios'); // Ensure axios is imported at top of file

// --- Send PDF Endpoint ---
app.post('/send-pdf', async (req, res) => {
    const { number, pdfUrl, fileName, caption } = req.body;

    if (!isConnected) {
        return res.status(503).json({ status: 'error', message: 'WhatsApp client is not connected.' });
    }

    if (!number || !pdfUrl) {
        return res.status(400).json({ status: 'error', message: 'Fields "number" and "pdfUrl" are required.' });
    }

    try {
        // 1. Format recipient phone number
        let formattedNumber = number.replace(/\D/g, '');
        if (!formattedNumber.endsWith('@s.whatsapp.net')) {
            formattedNumber = `${formattedNumber}@s.whatsapp.net`;
        }

        // 2. Fetch the PDF file as a Buffer
        const response = await axios.get(pdfUrl, { responseType: 'arraybuffer' });
        const pdfBuffer = Buffer.from(response.data, 'binary');

        // 3. Send document via Baileys
        const sent = await sock.sendMessage(formattedNumber, {
            document: pdfBuffer,
            mimetype: 'application/pdf',
            fileName: fileName || 'document.pdf', // File name shown in WhatsApp
            caption: caption || ''                // Optional text caption under the file
        });

        return res.json({ 
            status: 'success', 
            message: 'PDF sent successfully!', 
            messageId: sent.key.id 
        });

    } catch (error) {
        console.error('Error sending PDF:', error);
        return res.status(500).json({ status: 'error', error: error.message });
    }
});


// 4. Web Page at '/'
app.get('/', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>WhatsApp Web QR Link</title>
            <style>
                body { font-family: Arial, sans-serif; text-align: center; padding-top: 50px; background: #f0f2f5; }
                .card { background: white; padding: 30px; border-radius: 12px; display: inline-block; box-shadow: 0 4px 12px rgba(0,0,0,0.1); width: 320px; }
                img { width: 250px; height: 250px; margin-top: 15px; }
                .connected { color: #25D366; }
            </style>
        </head>
        <body>
            <div class="card">
                <div id="content">
                    <h3>⏳ Initializing...</h3>
                </div>
            </div>

            <script>
                async function checkStatus() {
                    try {
                        const res = await fetch('/qr-data');
                        const data = await res.json();
                        const content = document.getElementById('content');

                        if (data.connected) {
                            content.innerHTML = '<h2 class="connected">✅ Connected!</h2><p>WhatsApp session is active.</p>';
                        } else if (data.qr) {
                            content.innerHTML = '<h2>Scan with WhatsApp</h2><p>Linked Devices → Link a Device</p><img src="' + data.qr + '" />';
                        } else {
                            content.innerHTML = '<h3>⏳ Generating QR Code...</h3>';
                        }
                    } catch (e) {
                        console.error(e);
                    }
                }

                setInterval(checkStatus, 2000);
                checkStatus();
            </script>
        </body>
        </html>
    `);
});

app.listen(PORT, () => {
    console.log(`🌐 Server running on http://localhost:${PORT}`);
    startWhatsApp();
});
