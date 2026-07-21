require('dotenv').config();
const { 
    default: makeWASocket, 
    DisconnectReason, 
    useMultiFileAuthState,
    fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');
const QRCode = require('qrcode');
const express = require('express');
const cors = require('cors');
const pino = require('pino');
const fs = require('fs');
const path = require('path');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;
const AUTH_FOLDER = path.join(__dirname, '.baileys_auth');

app.use(cors());
app.use(express.json());

let sock;
let isConnected = false;
let currentQrDataUrl = null;
let currentPairingCode = null;
let qrGenerationCount = 0; // Tracks QR sequence to bypass the initial cold payload

function deleteAuthFolder() {
    if (fs.existsSync(AUTH_FOLDER)) {
        try {
            fs.rmSync(AUTH_FOLDER, { recursive: true, force: true });
            console.log('🧹 Local .baileys_auth folder wiped successfully.');
        } catch (err) {
            console.error('Error deleting .baileys_auth folder:', err);
        }
    }
}

async function startWhatsApp() {
    try {
        // Reset QR state on every boot/reconnect attempt
        currentQrDataUrl = null;
        currentPairingCode = null;
        qrGenerationCount = 0;

        const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);
        const { version } = await fetchLatestBaileysVersion();

        sock = makeWASocket({
            version,
            auth: state,
            printQRInTerminal: false,
            logger: pino({ level: 'silent' }),
            browser: ['Mac OS', 'Chrome', '120.0.0.0'],
            connectTimeoutMs: 60000,
            keepAliveIntervalMs: 25000,
            // Helps stabilize initial connection handshakes
            syncFullHistory: false 
        });

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                qrGenerationCount++;

                // Give a brief 1-second delay so the WebSocket buffer settles before serving the QR image
                await new Promise(resolve => setTimeout(resolve, 1000));

                try {
                    currentQrDataUrl = await QRCode.toDataURL(qr, {
                        margin: 4,
                        scale: 10,
                        color: {
                            dark: '#000000',
                            light: '#FFFFFF'
                        }
                    });
                    console.log(`🔄 Active QR code generated (Sequence #${qrGenerationCount})`);
                } catch (err) {
                    console.error('Failed to generate QR code:', err);
                }
            }

            if (connection === 'close') {
                isConnected = false;
                currentQrDataUrl = null;
                currentPairingCode = null;

                const statusCode = lastDisconnect?.error?.output?.statusCode;
                const isLoggedOut = statusCode === DisconnectReason.loggedOut;

                if (isLoggedOut) {
                    console.log('🔒 Device logged out. Wiping .baileys_auth directory...');
                    deleteAuthFolder();
                    setTimeout(startWhatsApp, 2000);
                } else {
                    console.log(`Connection closed (Reason: ${statusCode}). Reconnecting in 3s...`);
                    setTimeout(startWhatsApp, 3000);
                }
            } else if (connection === 'open') {
                isConnected = true;
                currentQrDataUrl = null;
                currentPairingCode = null;
                console.log('✅ WhatsApp connection established and active!');
            }
        });

    } catch (err) {
        console.error('Fatal initialization error:', err);
    }
}

// --- API & UI Routes ---

app.get('/qr-data', (req, res) => {
    res.json({
        connected: isConnected,
        qr: currentQrDataUrl,
        pairingCode: currentPairingCode
    });
});

app.post('/request-pairing-code', async (req, res) => {
    const { phoneNumber } = req.body;

    if (isConnected) {
        return res.status(400).json({ error: 'WhatsApp is already connected!' });
    }

    if (!phoneNumber) {
        return res.status(400).json({ error: 'Phone number is required.' });
    }

    try {
        const cleanedNumber = phoneNumber.replace(/\D/g, '');
        if (!sock.authState.creds.registered) {
            const code = await sock.requestPairingCode(cleanedNumber);
            currentPairingCode = code;
            console.log(`📲 Generated Pairing Code: ${code}`);
            return res.json({ status: 'success', pairingCode: code });
        } else {
            return res.status(400).json({ error: 'Session already registered.' });
        }
    } catch (error) {
        console.error('Error generating pairing code:', error);
        return res.status(500).json({ error: error.message });
    }
});

app.post('/logout', async (req, res) => {
    try {
        if (sock && isConnected) {
            await sock.logout();
        } else {
            deleteAuthFolder();
            isConnected = false;
            currentQrDataUrl = null;
            currentPairingCode = null;
            setTimeout(startWhatsApp, 2000);
        }
        return res.json({ status: 'success', message: 'Logged out successfully!' });
    } catch (error) {
        console.error('Logout error:', error);
        deleteAuthFolder();
        setTimeout(startWhatsApp, 2000);
        return res.json({ status: 'success', message: 'Session reset forcefully.' });
    }
});

app.get('/', (req, res) => {
    res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>WhatsApp Linking Dashboard</title>
        <style>
            body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; display: flex; justify-content: center; align-items: center; min-height: 100vh; background-color: #f0f2f5; margin: 0; }
            .card { background: white; padding: 35px; border-radius: 12px; box-shadow: 0 4px 16px rgba(0,0,0,0.08); text-align: center; max-width: 420px; width: 100%; }
            .qr-box { background: #ffffff; padding: 12px; display: inline-block; border-radius: 8px; border: 1px solid #e0e0e0; margin: 15px 0; }
            img { display: block; width: 250px; height: 250px; }
            .divider { margin: 25px 0 15px 0; border-top: 1px solid #eee; position: relative; }
            .divider span { background: white; padding: 0 10px; position: absolute; top: -10px; left: 50%; transform: translateX(-50%); color: #888; font-size: 0.8rem; }
            input { width: 100%; padding: 12px; border: 1px solid #ccc; border-radius: 6px; box-sizing: border-box; font-size: 1rem; margin-bottom: 10px; }
            button { width: 100%; padding: 12px; background: #25D366; color: white; border: none; border-radius: 6px; font-weight: bold; font-size: 1rem; cursor: pointer; }
            button:hover { background: #1ebd59; }
            .btn-logout { background: #dc3545; margin-top: 15px; }
            .btn-logout:hover { background: #bb2d3b; }
            .code-display { font-size: 1.8rem; font-weight: bold; letter-spacing: 4px; color: #111b21; background: #e8f5e9; padding: 12px; border-radius: 6px; margin-top: 10px; border: 1px dashed #25D366; }
            .status-online { color: #2e7d32; font-weight: bold; font-size: 1.2rem; }
            .loader { border: 4px solid #f3f3f3; border-top: 4px solid #25D366; border-radius: 50%; width: 36px; height: 36px; animation: spin 1s linear infinite; margin: 20px auto; }
            @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
        </style>
    </head>
    <body>
        <div class="card">
            <div id="content">
                <div class="loader"></div>
                <p>Initializing WhatsApp connection...</p>
            </div>
        </div>

        <script>
            async function requestPairingCode() {
                const phoneInput = document.getElementById('phoneInput').value;
                if (!phoneInput) return alert('Please enter your phone number with country code');

                try {
                    const res = await fetch('/request-pairing-code', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ phoneNumber: phoneInput })
                    });
                    const data = await res.json();
                    if (data.error) alert(data.error);
                } catch (e) {
                    alert('Failed to request pairing code');
                }
            }

            async function logoutWhatsApp() {
                if (!confirm('Are you sure you want to disconnect WhatsApp? Your local session folder will be cleared.')) return;

                try {
                    const res = await fetch('/logout', { method: 'POST' });
                    const data = await res.json();
                    if (data.status === 'success') {
                        location.reload();
                    } else {
                        alert(data.error || 'Failed to logout');
                    }
                } catch (e) {
                    alert('Error sending logout request');
                }
            }

            async function checkStatus() {
                try {
                    const res = await fetch('/qr-data');
                    const data = await res.json();
                    const container = document.getElementById('content');

                    if (data.connected) {
                        container.innerHTML = \`
                            <h2 class="status-online">✅ WhatsApp Connected</h2>
                            <p style="color: #666; font-size: 0.9rem;">Your bot is authenticated and active.</p>
                            <button class="btn-logout" onclick="logoutWhatsApp()">Logout / Disconnect</button>
                        \`;
                    } else {
                        let html = '<h3 style="margin-top: 0; color: #111b21;">Link WhatsApp</h3>';

                        if (data.qr) {
                            html += \`
                                <p style="color: #666; font-size: 0.85rem; margin: 0;">Option 1: Scan QR Code</p>
                                <div class="qr-box">
                                    <img src="\${data.qr}" alt="QR Code" />
                                </div>
                            \`;
                        } else {
                            html += '<div class="loader"></div><p style="color: #666;">Establishing secure connection...</p>';
                        }

                        html += \`
                            <div class="divider"><span>OR</span></div>
                            <p style="color: #666; font-size: 0.85rem; margin-bottom: 10px;">Option 2: Use 8-Digit Pairing Code</p>
                        \`;

                        if (data.pairingCode) {
                            html += \`
                                <p style="font-size: 0.8rem; color: #555; margin-bottom: 5px;">Enter this code on your phone:</p>
                                <div class="code-display">\${data.pairingCode}</div>
                            \`;
                        } else {
                            html += \`
                                <input type="text" id="phoneInput" placeholder="e.g., 15551234567 (with country code)" />
                                <button onclick="requestPairingCode()">Get Pairing Code</button>
                            \`;
                        }

                        container.innerHTML = html;
                    }
                } catch (e) {
                    console.error('Polling error', e);
                }
            }

            setInterval(checkStatus, 2500);
            checkStatus();
        </script>
    </body>
    </html>
    `);
});

app.post('/send-message', async (req, res) => {
    const { number, message } = req.body;

    if (!isConnected) return res.status(503).json({ error: 'WhatsApp not connected' });
    if (!number || !message) return res.status(400).json({ error: 'Missing number or message' });

    try {
        let formattedNumber = number.replace(/\D/g, '') + '@s.whatsapp.net';
        const sent = await sock.sendMessage(formattedNumber, { text: message });
        res.json({ status: 'success', messageId: sent.key.id });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

const path = require('path');
const { URL } = require('url');
// Helper function to extract filename from URL or headers
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


app.listen(PORT, () => {
    console.log(`🌐 Server active on http://localhost:${PORT}`);
    startWhatsApp();
});
