const { default: makeWASocket, DisconnectReason, useMultiFileAuthState } = require('@whiskeysockets/baileys');
const { createClient } = require('@supabase/supabase-js');
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

const SUPABASE_URL = process.env.SUPABASEURL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASESERVICEROLEKEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('❌ SUPABASEURL e SUPABASESERVICEROLEKEY obrigatórios');
  process.exit(1);
}

console.log('✅ Supabase configurado');
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
const activeConnections = new Map();

// Diretório para auth state
const AUTH_DIR = path.join(__dirname, 'auth_sessions');
if (!fs.existsSync(AUTH_DIR)) {
  fs.mkdirSync(AUTH_DIR, { recursive: true });
}

function getAuthPath(clienteId) {
  return path.join(AUTH_DIR, clienteId);
}

async function createWhatsAppConnection(clienteId) {
  console.log(`🔄 Iniciando conexão WhatsApp para cliente: ${clienteId}`);
  
  if (activeConnections.has(clienteId)) {
    const existing = activeConnections.get(clienteId);
    if (existing.qr) {
      console.log('📱 QR já existe, retornando');
      return existing.qr;
    }
  }

  return new Promise(async (resolve, reject) => {
    const timeout = setTimeout(() => {
      console.log('⏱️ Timeout de 30s');
      reject(new Error('Timeout ao gerar QR'));
    }, 30000);

    try {
      const authPath = getAuthPath(clienteId);
      const { state, saveCreds } = await useMultiFileAuthState(authPath);

      const sock = makeWASocket({
        auth: state,
        printQRInTerminal: false
      });

      activeConnections.set(clienteId, { sock, qr: null });

      sock.ev.on('creds.update', saveCreds);

      sock.ev.on('connection.update', async (update) => {
        const { connection, qr, lastDisconnect } = update;

        if (qr) {
          console.log('📱 QR Code gerado');
          const conn = activeConnections.get(clienteId);
          if (conn) conn.qr = qr;
          clearTimeout(timeout);
          resolve(qr);
        }

        if (connection === 'open') {
          console.log('✅ WhatsApp conectado');
          await supabase
            .from('clientes')
            .update({ whatsapp_conectado: true })
            .eq('id', clienteId);
        }

        if (connection === 'close') {
          console.log('⚠️ Conexão fechada');
          const shouldReconnect = 
            lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
          
          activeConnections.delete(clienteId);
          
          if (!shouldReconnect) {
            await supabase
              .from('clientes')
              .update({ whatsapp_conectado: false })
              .eq('id', clienteId);
          }
        }
      });

    } catch (err) {
      clearTimeout(timeout);
      console.error('❌ Erro:', err.message);
      reject(err);
    }
  });
}

app.get('/health', (req, res) => {
  res.json({
    status: 'online',
    activeConnections: activeConnections.size,
    timestamp: new Date().toISOString()
  });
});

app.post('/generate-qr', async (req, res) => {
  const { clienteId } = req.body;
  
  if (!clienteId) {
    return res.status(400).json({ error: 'clienteId obrigatório' });
  }

  try {
    console.log(`🎯 Gerando QR para: ${clienteId}`);
    const qr = await createWhatsAppConnection(clienteId);
    res.json({ qr });
  } catch (err) {
    console.error('❌ Erro:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/disconnect', async (req, res) => {
  const { clienteId } = req.body;
  
  if (!clienteId) {
    return res.status(400).json({ error: 'clienteId obrigatório' });
  }

  try {
    const connection = activeConnections.get(clienteId);
    if (connection?.sock) {
      await connection.sock.logout();
    }
    
    activeConnections.delete(clienteId);
    
    const authPath = getAuthPath(clienteId);
    if (fs.existsSync(authPath)) {
      fs.rmSync(authPath, { recursive: true, force: true });
    }
    
    await supabase
      .from('clientes')
      .update({ whatsapp_conectado: false })
      .eq('id', clienteId);
    
    res.json({ success: true });
  } catch (err) {
    console.error('❌ Erro ao desconectar:', err.message);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
  console.log('📡 Endpoints: /health, /generate-qr, /disconnect');
});
