const { default: makeWASocket, DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const { createClient } = require('@supabase/supabase-js');
const express = require('express');
const cors = require('cors');
const pino = require('pino');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(cors());
app.use(express.json());

const SUPABASE_URL = process.env.SUPABASEURL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASESERVICEROLEKEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('❌ SUPABASEURL e SUPABASESERVICEROLEKEY são obrigatórias');
  process.exit(1);
}

console.log('✅ Supabase configurado');
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
const logger = pino({ level: 'silent' });

const connections = new Map();

async function createWhatsAppConnection(clienteId) {
  console.log('🔄 Iniciando conexão WhatsApp para cliente:', clienteId);
  
  if (connections.has(clienteId)) {
    const existing = connections.get(clienteId);
    if (existing.qr) {
      console.log('📱 Retornando QR code existente');
      return existing.qr;
    }
  }

  return new Promise(async (resolve, reject) => {
    let resolved = false;
    const authDir = path.join(__dirname, 'auth_sessions', clienteId);

    try {
      if (!fs.existsSync(authDir)) {
        fs.mkdirSync(authDir, { recursive: true });
      }

      const { state, saveCreds } = await useMultiFileAuthState(authDir);
      const { version } = await fetchLatestBaileysVersion();
      
      console.log('📦 Baileys version:', version);

      const sock = makeWASocket({
        version,
        logger,
        printQRInTerminal: false,
        auth: state,
        browser: ['MBNG', 'Chrome', '120.0.0'],
        connectTimeoutMs: 60000,
        defaultQueryTimeoutMs: undefined,
        keepAliveIntervalMs: 30000,
        getMessage: async () => undefined
      });

      const connData = { sock, qr: null, connected: false };
      connections.set(clienteId, connData);

      sock.ev.on('creds.update', saveCreds);

      sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr && !resolved) {
          console.log('📱 QR Code gerado!');
          connData.qr = qr;
          resolved = true;
          resolve(qr);
        }

        if (connection === 'open') {
          console.log('✅ WhatsApp conectado para cliente:', clienteId);
          connData.connected = true;
          
          await supabase
            .from('clientes')
            .update({ whatsapp_conectado: true })
            .eq('id', clienteId);
        }

        if (connection === 'close') {
          const statusCode = lastDisconnect?.error?.output?.statusCode;
          console.log('⚠️ Conexão fechada. Status:', statusCode);
          
          const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
          
          if (!shouldReconnect) {
            console.log('🔐 Logout detectado - limpando sessão');
            
            if (fs.existsSync(authDir)) {
              fs.rmSync(authDir, { recursive: true, force: true });
            }
            
            await supabase
              .from('clientes')
              .update({ whatsapp_conectado: false })
              .eq('id', clienteId);
          }
          
          connections.delete(clienteId);
        }
      });

      sock.ev.on('messages.upsert', async ({ messages }) => {
        console.log('📨 Mensagem recebida:', messages.length);
      });

      setTimeout(() => {
        if (!resolved) {
          console.log('⏱️ Timeout ao gerar QR code');
          connections.delete(clienteId);
          reject(new Error('Timeout ao gerar QR Code'));
        }
      }, 20000);

    } catch (err) {
      console.error('❌ Erro ao criar conexão:', err);
      connections.delete(clienteId);
      if (!resolved) {
        reject(err);
      }
    }
  });
}

app.get('/health', (req, res) => {
  res.json({
    status: 'online',
    activeConnections: connections.size,
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

app.post('/generate-qr', async (req, res) => {
  const { clienteId } = req.body;
  
  if (!clienteId) {
    return res.status(400).json({ error: 'clienteId é obrigatório' });
  }

  try {
    console.log('🎯 Solicitação de QR para:', clienteId);
    const qr = await createWhatsAppConnection(clienteId);
    res.json({ qr });
  } catch (err) {
    console.error('❌ Erro ao gerar QR:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/disconnect', async (req, res) => {
  const { clienteId } = req.body;
  
  if (!clienteId) {
    return res.status(400).json({ error: 'clienteId é obrigatório' });
  }

  try {
    const conn = connections.get(clienteId);
    
    if (conn?.sock) {
      await conn.sock.logout();
    }
    
    const authDir = path.join(__dirname, 'auth_sessions', clienteId);
    if (fs.existsSync(authDir)) {
      fs.rmSync(authDir, { recursive: true, force: true });
    }
    
    connections.delete(clienteId);
    
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
  console.log(`🚀 Servidor MBNG WhatsApp rodando na porta ${PORT}`);
  console.log('📡 Endpoints disponíveis:');
  console.log('  GET  /health');
  console.log('  POST /generate-qr');
  console.log('  POST /disconnect');
});
