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

const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

let sock;
let isConnected = false;
let qrCodeUrl = null;
let pairingCode = null;

// Clean invalid or expired auth files
function clearAuthFolder() {
    const authPath = './.baileys_auth';
    if (fs.existsSync(authPath)) {
        try {
            fs.rmSync(authPath, { recursive: true, force: true });
            console.log('🧹 Cleared .baileys_auth session folder.');
        } catch (err) {
            console.error('Error clearing session folder:', err);
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
                // FIX: Add explicit quiet zone margin (padding) & size
                qrCodeUrl = await QRCode.toDataURL(qr, {
                    margin: 6,         // Generates clear quiet zone around QR
                    width: 300,        // Ensures high resolution
                    color: {
                        dark: '#000000',
                        light: '#FFFFFF'
                    }
                });
                qrcodeTerminal.generate(qr, { small: true });
            } catch (err) {
                console.error('Failed to generate QR Code:', err);
            }
        }

        if (connection === 'close') {
            isConnected = false;
            qrCodeUrl = null;
            pairingCode = null;

            const statusCode = lastDisconnect?.error?.output?.statusCode || lastDisconnect?.error?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

            console.log(`⚠️ Connection closed (Code ${statusCode}). Reconnecting: ${shouldReconnect}`);

            if (shouldReconnect) {
                setTimeout(startWhatsApp, 3000);
            } else {
                console.log('❌ Logged out. Resetting auth folder...');
                clearAuthFolder();
                setTimeout(startWhatsApp, 3000);
            }
        } else if (connection === 'open') {
            isConnected = true;
            qrCodeUrl = null;
            pairingCode = null;
            console.log('✅ Connected successfully to WhatsApp!');
        }
    });
}

// Helpers
function formatJid(number) {
    let cleaned = number.replace(/\D/g, '');
    if (!cleaned.endsWith('@s.whatsapp.net')) {
        cleaned = `${cleaned}@s.whatsapp.net`;
    }
    return cleaned;
}

// --- Express Endpoints ---

// Data Endpoint for UI
app.get('/qr-data', (req, res) => {
    res.json({
        connected: isConnected,
        qr: qrCodeUrl,
        pairingCode: pairingCode
    });
});

// Backup Method: Generate 8-digit Pairing Code via Phone Number
app.post('/pair-code', async (req, res) => {
    const { number } = req.body;
    if (!number) {
        return res.status(400).json({ status: 'error', message: 'Field "number" is required.' });
    }

    try {
        const cleanedNumber = number.replace(/\D/g, '');
        if (sock && !isConnected) {
            const code = await sock.requestPairingCode(cleanedNumber);
            pairingCode = code;
            return res.json({ status: 'success', pairingCode: code });
        }
        return res.status(400).json({ status: 'error', message: 'Socket is connected or not ready.' });
    } catch (err) {
        return res.status(500).json({ status: 'error', error: err.message });
    }
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
        const jid = formatJid(number);
        const sent = await sock.sendMessage(jid, { text: message });
        return res.json({ status: 'success', messageId: sent.key.id });
    } catch (error) {
        console.error('Failed to send message:', error);
        return res.status(500).json({ status: 'error', error: error.message });
    }
});

//SEND-PDF
// Helper function to extract filename from URL or headers
const path = require('path');
const { URL } = require('url');

function getFileNameFromUrl(pdfUrl, contentDispositionHeader) {
    // 1. Try extracting from Content-Disposition header (e.g., 'attachment; filename="Invoice_2026.pdf"')
    if (contentDispositionHeader) {
        const match = contentDispositionHeader.match(/filename\*?=(?:'[^']*')?["']?([^"';\n]+)["']?/i);
        if (match && match[1]) {
            return decodeURIComponent(match[1]);
        }
    }

    // 2. Fallback: Parse the file name from URL path (e.g., https://site.com/docs/Report_Q2.pdf -> Report_Q2.pdf)
    try {
        const parsedUrl = new URL(pdfUrl);
        const basename = path.basename(parsedUrl.pathname);
        if (basename && basename.toLowerCase().endsWith('.pdf')) {
            return decodeURIComponent(basename);
        }
    } catch (e) {
        // Ignore URL parsing errors
    }

    // 3. Ultimate fallback if URL has no clear filename
    return 'document.pdf';
}

// --- Send PDF Endpoint ---
app.post('/send-pdf', async (req, res) => {
    const { number, pdfUrl, fileName: customFileName, caption } = req.body;

    if (!isConnected) {
        return res.status(503).json({ status: 'error', message: 'WhatsApp client is not connected.' });
    }

    if (!number || !pdfUrl) {
        return res.status(400).json({ status: 'error', message: 'Fields "number" and "pdfUrl" are required.' });
    }

    try {
        let formattedNumber = number.replace(/\D/g, '');
        if (!formattedNumber.endsWith('@s.whatsapp.net')) {
            formattedNumber = `${formattedNumber}@s.whatsapp.net`;
        }

        // Fetch PDF file buffer and headers
        const response = await axios.get(pdfUrl, { responseType: 'arraybuffer' });
        const pdfBuffer = Buffer.from(response.data, 'binary');

        // Resolve filename: Explicit request parameter -> Server Header / URL path -> Default fallback
        const resolvedFileName = customFileName || getFileNameFromUrl(pdfUrl, response.headers['content-disposition']);

        const sent = await sock.sendMessage(formattedNumber, {
            document: pdfBuffer,
            mimetype: 'application/pdf',
            fileName: resolvedFileName, // Preserves original filename automatically
            caption: caption || ''
        });

        return res.json({ 
            status: 'success', 
            message: `PDF (${resolvedFileName}) sent successfully!`, 
            messageId: sent.key.id 
        });

    } catch (error) {
        console.error('Error sending PDF:', error);
        return res.status(500).json({ status: 'error', error: error.message });
    }
});


// UI Route
app.get('/', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>WhatsApp Web Link</title>
            <style>
                body { font-family: Arial, sans-serif; text-align: center; padding-top: 40px; background: #f0f2f5; }
                .card { background: white; padding: 30px; border-radius: 12px; display: inline-block; box-shadow: 0 4px 12px rgba(0,0,0,0.1); width: 340px; }
                .qr-container { background: #ffffff; padding: 15px; display: inline-block; border-radius: 8px; border: 1px solid #ddd; margin-top: 10px; }
                img { width: 260px; height: 260px; display: block; }
                .connected { color: #25D366; }
                .code-box { font-size: 24px; font-weight: bold; letter-spacing: 4px; background: #e7fceb; color: #075e54; padding: 10px; border-radius: 6px; margin: 15px 0; }
                input { width: 80%; padding: 10px; margin-bottom: 10px; border: 1px solid #ccc; border-radius: 4px; }
                button { background: #25D366; color: white; border: none; padding: 10px 15px; border-radius: 4px; cursor: pointer; font-weight: bold; }
                button:hover { background: #1ebd59; }
                .divider { margin: 20px 0; border-bottom: 1px solid #eee; }
            </style>
        </head>
        <body>
            <div class="card">
                <div id="content">
                    <h3>⏳ Initializing WhatsApp...</h3>
                </div>
            </div>

            <script>
                async function requestPairCode() {
                    const phone = document.getElementById('phone').value;
                    if (!phone) return alert('Enter phone number with country code');
                    
                    const res = await fetch('/pair-code', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ number: phone })
                    });
                    const data = await res.json();
                    if (data.pairingCode) {
                        checkStatus();
                    } else {
                        alert('Error: ' + (data.message || data.error));
                    }
                }

                async function checkStatus() {
                    try {
                        const res = await fetch('/qr-data');
                        const data = await res.json();
                        const content = document.getElementById('content');

                        if (data.connected) {
                            content.innerHTML = '<h2 class="connected">✅ Connected!</h2><p>WhatsApp session is active.</p>';
                        } else if (data.pairingCode) {
                            content.innerHTML = '<h2>Pairing Code</h2><p>Enter this code on your phone:</p><div class="code-box">' + data.pairingCode + '</div>';
                        } else if (data.qr) {
                            content.innerHTML = '<h2>Scan with WhatsApp</h2><p>Linked Devices → Link a Device</p><div class="qr-container"><img src="' + data.qr + '" /></div><div class="divider"></div><p><strong>Or use Phone Number:</strong></p><input type="text" id="phone" placeholder="e.g. 15551234567" /><br/><button onclick="requestPairCode()">Get Pairing Code</button>';
                        } else {
                            content.innerHTML = '<h3>⏳ Generating Connection Code...</h3>';
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

const HOST = process.env.HOST || '0.0.0.0';
let serverPort = process.env.PORT || 3000;

const server = app.listen(serverPort, HOST, () => {
    console.log(`🌐 Server running on http://${HOST}:${serverPort}`);
    startWhatsApp();
});

// Automatically handle EADDRINUSE error by retrying on a new port
server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
        console.warn(`⚠️ Port ${serverPort} is in use. Trying port ${Number(serverPort) + 1}...`);
        serverPort = Number(serverPort) + 1;
        setTimeout(() => {
            server.listen(serverPort, HOST);
        }, 1000);
    } else {
        console.error('Server error:', err);
    }
});