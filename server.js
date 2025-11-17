const { default: makeWASocket, DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion, Browsers } = require('@whiskeysockets/baileys');
const { createClient } = require('@supabase/supabase-js');
const { Boom } = require('@hapi/boom');
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

// Gerenciamento de instâncias (Evolution API pattern)
const instances = new Map();

/**
 * Criar/Reconectar instância WhatsApp (Evolution API inspired)
 */
async function connectToWhatsApp(clienteId) {
  console.log(`[${clienteId}] 🔄 Iniciando conexão WhatsApp...`);
  
  const authDir = path.join(__dirname, 'auth_sessions', clienteId);
  
  try {
    // Criar diretório se não existir
    if (!fs.existsSync(authDir)) {
      fs.mkdirSync(authDir, { recursive: true });
      console.log(`[${clienteId}] 📁 Diretório de sessão criado`);
    }

    // Carregar estado de autenticação
    const { state, saveCreds } = await useMultiFileAuthState(authDir);
    const { version } = await fetchLatestBaileysVersion();
    
    console.log(`[${clienteId}] 📦 Baileys version: ${version.join('.')}`);

    // Criar socket com configurações Evolution API
    const sock = makeWASocket({
      version,
      logger,
      printQRInTerminal: false,
      auth: state,
      browser: Browsers.ubuntu('MBNG'),
      connectTimeoutMs: 60000,
      defaultQueryTimeoutMs: 0,
      keepAliveIntervalMs: 10000,
      emitOwnEvents: false,
      markOnlineOnConnect: true,
      syncFullHistory: false,
      getMessage: async () => undefined
    });

    // Guardar instância
    const instance = {
      sock,
      state: 'connecting',
      qrCode: null,
      retryCount: 0
    };
    instances.set(clienteId, instance);

    // ====================================
    // EVENTO: ATUALIZAÇÃO DE CREDENCIAIS
    // ====================================
    sock.ev.on('creds.update', async () => {
      console.log(`[${clienteId}] 🔐 Credenciais atualizadas`);
      await saveCreds();
    });

    // ====================================
    // EVENTO: ATUALIZAÇÃO DE CONEXÃO (CRÍTICO)
    // ====================================
    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr, isNewLogin, receivedPendingNotifications } = update;
      
      console.log(`[${clienteId}] 📡 Connection update:`, {
        connection,
        isNewLogin,
        hasQR: !!qr,
        hasError: !!lastDisconnect?.error
      });

      // ====================================
      // QR CODE GERADO
      // ====================================
      if (qr) {
        console.log(`[${clienteId}] 📱 QR Code gerado!`);
        instance.qrCode = qr;
        instance.state = 'qr_ready';
      }

      // ====================================
      // CONECTADO COM SUCESSO
      // ====================================
      if (connection === 'open') {
        console.log(`[${clienteId}] ✅ Conectado com sucesso!`);
        instance.state = 'open';
        instance.qrCode = null;
        instance.retryCount = 0;

        // Atualizar Supabase
        await supabase
          .from('clientes')
          .update({ 
            whatsapp_conectado: true,
            updated_at: new Date().toISOString()
          })
          .eq('id', clienteId);

        console.log(`[${clienteId}] ✅ Status atualizado no banco`);
      }

      // ====================================
      // CONEXÃO FECHADA
      // ====================================
      if (connection === 'close') {
        instance.state = 'close';
        instance.qrCode = null;

        const statusCode = (lastDisconnect?.error)?.output?.statusCode;
        const reason = lastDisconnect?.error;
        
        console.log(`[${clienteId}] ⚠️ Conexão fechada:`, {
          statusCode,
          reason: reason?.message
        });

        // Determinar se deve reconectar
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
        const shouldRetry = instance.retryCount < 5;

        if (statusCode === DisconnectReason.loggedOut) {
          console.log(`[${clienteId}] 🔐 Logout - Limpando sessão`);
          
          // Limpar sessão
          if (fs.existsSync(authDir)) {
            fs.rmSync(authDir, { recursive: true, force: true });
          }
          
          // Atualizar banco
          await supabase
            .from('clientes')
            .update({ 
              whatsapp_conectado: false,
              updated_at: new Date().toISOString()
            })
            .eq('id', clienteId);
          
          // Remover instância
          instances.delete(clienteId);
          
        } else if (shouldReconnect && shouldRetry) {
          console.log(`[${clienteId}] 🔄 Reconectando... (tentativa ${instance.retryCount + 1}/5)`);
          instance.retryCount++;
          
          // Aguardar antes de reconectar (backoff exponencial)
          const delay = Math.min(1000 * Math.pow(2, instance.retryCount), 30000);
          setTimeout(() => connectToWhatsApp(clienteId), delay);
          
        } else {
          console.log(`[${clienteId}] ❌ Não reconectando (shouldReconnect: ${shouldReconnect}, shouldRetry: ${shouldRetry})`);
          instances.delete(clienteId);
          
          // Atualizar banco
          await supabase
            .from('clientes')
            .update({ 
              whatsapp_conectado: false,
              updated_at: new Date().toISOString()
            })
            .eq('id', clienteId);
        }
      }
    });

    // ====================================
    // EVENTO: MENSAGENS RECEBIDAS
    // ====================================
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      console.log(`[${clienteId}] 📨 ${messages.length} mensagem(ns) recebida(s) (${type})`);
      
      for (const msg of messages) {
        if (!msg.message) continue;
        
        const messageInfo = {
          from: msg.key.remoteJid,
          messageId: msg.key.id,
          timestamp: msg.messageTimestamp,
          isFromMe: msg.key.fromMe
        };
        
        console.log(`[${clienteId}] 💬 Mensagem:`, messageInfo);
        
        // TODO: Salvar mensagem no Supabase
        // Implementar conforme necessário
      }
    });

    console.log(`[${clienteId}] ✅ Instância criada com sucesso`);
    return instance;

  } catch (error) {
    console.error(`[${clienteId}] ❌ Erro ao criar instância:`, error);
    instances.delete(clienteId);
    throw error;
  }
}

// ====================================
// ENDPOINTS
// ====================================

/**
 * Health Check
 */
app.get('/health', (req, res) => {
  const instancesStatus = Array.from(instances.entries()).map(([id, inst]) => ({
    clienteId: id,
    state: inst.state,
    hasQR: !!inst.qrCode
  }));

  res.json({
    status: 'online',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    instances: instancesStatus.length,
    details: instancesStatus
  });
});

/**
 * Gerar QR Code
 */
app.post('/generate-qr', async (req, res) => {
  const { clienteId } = req.body;
  
  if (!clienteId) {
    return res.status(400).json({ error: 'clienteId é obrigatório' });
  }

  console.log(`[${clienteId}] 🎯 Solicitação de QR Code`);

  try {
    // Verificar se já existe instância
    let instance = instances.get(clienteId);
    
    if (instance) {
      console.log(`[${clienteId}] ℹ️ Instância existente (state: ${instance.state})`);
      
      // Se já conectado
      if (instance.state === 'open') {
        return res.json({ 
          success: true, 
          message: 'Já conectado',
          connected: true 
        });
      }
      
      // Se tem QR disponível
      if (instance.qrCode) {
        console.log(`[${clienteId}] 📱 Retornando QR existente`);
        return res.json({ qr: instance.qrCode });
      }
      
      // Aguardar QR ser gerado (timeout 15s)
      const maxWait = 15000;
      const startTime = Date.now();
      
      while (Date.now() - startTime < maxWait) {
        instance = instances.get(clienteId);
        if (instance?.qrCode) {
          console.log(`[${clienteId}] 📱 QR gerado (após ${Date.now() - startTime}ms)`);
          return res.json({ qr: instance.qrCode });
        }
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      
      throw new Error('Timeout aguardando QR code');
    }

    // Criar nova instância
    console.log(`[${clienteId}] 🆕 Criando nova instância`);
    instance = await connectToWhatsApp(clienteId);
    
    // Aguardar QR ser gerado (timeout 15s)
    const maxWait = 15000;
    const startTime = Date.now();
    
    while (Date.now() - startTime < maxWait) {
      instance = instances.get(clienteId);
      if (instance?.qrCode) {
        console.log(`[${clienteId}] 📱 QR gerado (após ${Date.now() - startTime}ms)`);
        return res.json({ qr: instance.qrCode });
      }
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    
    throw new Error('Timeout aguardando QR code');
    
  } catch (error) {
    console.error(`[${clienteId}] ❌ Erro:`, error);
    res.status(500).json({ 
      error: error.message || 'Erro ao gerar QR code' 
    });
  }
});

/**
 * Desconectar
 */
app.post('/disconnect', async (req, res) => {
  const { clienteId } = req.body;
  
  if (!clienteId) {
    return res.status(400).json({ error: 'clienteId é obrigatório' });
  }

  console.log(`[${clienteId}] 🔌 Solicitação de desconexão`);

  try {
    const instance = instances.get(clienteId);
    
    if (instance?.sock) {
      console.log(`[${clienteId}] 🔐 Fazendo logout...`);
      await instance.sock.logout();
    }
    
    // Limpar sessão
    const authDir = path.join(__dirname, 'auth_sessions', clienteId);
    if (fs.existsSync(authDir)) {
      fs.rmSync(authDir, { recursive: true, force: true });
      console.log(`[${clienteId}] 🗑️ Sessão removida`);
    }
    
    // Remover instância
    instances.delete(clienteId);
    
    // Atualizar banco
    await supabase
      .from('clientes')
      .update({ 
        whatsapp_conectado: false,
        updated_at: new Date().toISOString()
      })
      .eq('id', clienteId);
    
    console.log(`[${clienteId}] ✅ Desconectado com sucesso`);
    res.json({ success: true });
    
  } catch (error) {
    console.error(`[${clienteId}] ❌ Erro ao desconectar:`, error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Status da Conexão
 */
app.get('/connection-state/:clienteId', (req, res) => {
  const { clienteId } = req.params;
  const instance = instances.get(clienteId);
  
  if (!instance) {
    return res.json({
      clienteId,
      state: 'disconnected',
      connected: false
    });
  }
  
  res.json({
    clienteId,
    state: instance.state,
    connected: instance.state === 'open',
    hasQR: !!instance.qrCode
  });
});

// ====================================
// INICIALIZAÇÃO
// ====================================

const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('🚀 =======================================');
  console.log('🚀 MBNG WhatsApp Server (Evolution API)');
  console.log('🚀 =======================================');
  console.log(`🚀 Porta: ${PORT}`);
  console.log('🚀 Endpoints:');
  console.log('🚀   GET  /health');
  console.log('🚀   POST /generate-qr');
  console.log('🚀   POST /disconnect');
  console.log('🚀   GET  /connection-state/:clienteId');
  console.log('🚀 =======================================');
  console.log('');
});

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('\n⚠️ Encerrando servidor...');
  
  for (const [clienteId, instance] of instances.entries()) {
    if (instance?.sock) {
      console.log(`[${clienteId}] Fechando conexão...`);
      instance.sock.end();
    }
  }
  
  process.exit(0);
});
