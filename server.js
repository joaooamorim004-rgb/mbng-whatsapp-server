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
        console.log(`[${clienteId}] ✅ WhatsApp CONECTADO COM SUCESSO!`);
        console.log(`[${clienteId}] 📝 Atualizando banco de dados...`);
        
        instance.state = 'open';
        instance.qrCode = null;
        instance.retryCount = 0;

        // Atualizar Supabase com tratamento de erro
        try {
          const { data, error } = await supabase
            .from('clientes')
            .update({ 
              whatsapp_conectado: true,
              updated_at: new Date().toISOString()
            })
            .eq('id', clienteId)
            .select();

          if (error) {
            console.error(`[${clienteId}] ❌ ERRO ao atualizar banco:`, error);
          } else {
            console.log(`[${clienteId}] ✅ STATUS ATUALIZADO NO BANCO:`, data);
          }
        } catch (err) {
          console.error(`[${clienteId}] ❌ EXCEÇÃO ao atualizar banco:`, err);
        }
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
          console.log(`[${clienteId}] 🔐 Logout detectado - Limpando sessão`);
          
          // Limpar sessão
          if (fs.existsSync(authDir)) {
            fs.rmSync(authDir, { recursive: true, force: true });
          }
          
          // Atualizar banco com tratamento de erro
          try {
            const { error } = await supabase
              .from('clientes')
              .update({ 
                whatsapp_conectado: false,
                updated_at: new Date().toISOString()
              })
              .eq('id', clienteId);
            
            if (error) {
              console.error(`[${clienteId}] ❌ Erro ao marcar desconectado:`, error);
            } else {
              console.log(`[${clienteId}] ✅ Status desconectado atualizado no banco`);
            }
          } catch (err) {
            console.error(`[${clienteId}] ❌ Exceção ao atualizar banco:`, err);
          }
          
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
          timestamp: new Date(msg.messageTimestamp * 1000).toISOString(),
          content: msg.message.conversation || msg.message.extendedTextMessage?.text || '',
          type: Object.keys(msg.message)[0]
        };

        console.log(`[${clienteId}] 💬 Mensagem:`, messageInfo);
        
        // TODO: Salvar mensagem no Supabase
        // await supabase.from('whatsapp_mensagens').insert({...})
      }
    });

    return sock;

  } catch (error) {
    console.error(`[${clienteId}] ❌ Erro crítico:`, error);
    instances.delete(clienteId);
    throw error;
  }
}

// ====================================
// ROTAS DA API
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
      let attempts = 0;
      const maxAttempts = 30; // 30 * 500ms = 15s
      
      while (!instance.qrCode && attempts < maxAttempts) {
        await new Promise(resolve => setTimeout(resolve, 500));
        instance = instances.get(clienteId);
        attempts++;
        
        if (instance?.qrCode) {
          console.log(`[${clienteId}] ✅ QR gerado após ${attempts * 500}ms`);
          return res.json({ qr: instance.qrCode });
        }
      }
      
      // Timeout
      console.log(`[${clienteId}] ⏱️ Timeout aguardando QR`);
      return res.status(408).json({ error: 'Timeout aguardando QR Code' });
    }
    
    // Criar nova instância
    console.log(`[${clienteId}] 🆕 Criando nova instância`);
    await connectToWhatsApp(clienteId);
    
    // Aguardar QR
    let attempts = 0;
    const maxAttempts = 30;
    
    while (attempts < maxAttempts) {
      await new Promise(resolve => setTimeout(resolve, 500));
      const inst = instances.get(clienteId);
      attempts++;
      
      if (inst?.qrCode) {
        console.log(`[${clienteId}] ✅ QR gerado após ${attempts * 500}ms`);
        return res.json({ qr: inst.qrCode });
      }
    }
    
    console.log(`[${clienteId}] ⏱️ Timeout criando nova instância`);
    return res.status(408).json({ error: 'Timeout ao gerar QR Code' });
    
  } catch (error) {
    console.error(`[${clienteId}] ❌ Erro:`, error);
    return res.status(500).json({ error: error.message });
  }
});

/**
 * Desconectar (Logout)
 */
app.post('/disconnect', async (req, res) => {
  const { clienteId } = req.body;
  
  if (!clienteId) {
    return res.status(400).json({ error: 'clienteId é obrigatório' });
  }

  console.log(`[${clienteId}] 🔌 Solicitação de desconexão`);

  try {
    const instance = instances.get(clienteId);
    
    if (!instance) {
      return res.json({ success: true, message: 'Nenhuma instância ativa' });
    }

    // Fazer logout
    if (instance.sock) {
      await instance.sock.logout();
    }

    // Limpar sessão
    const authDir = path.join(__dirname, 'auth_sessions', clienteId);
    if (fs.existsSync(authDir)) {
      fs.rmSync(authDir, { recursive: true, force: true });
      console.log(`[${clienteId}] 🗑️ Sessão removida`);
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
    
    console.log(`[${clienteId}] ✅ Desconectado com sucesso`);
    return res.json({ success: true, message: 'Desconectado' });
    
  } catch (error) {
    console.error(`[${clienteId}] ❌ Erro ao desconectar:`, error);
    return res.status(500).json({ error: error.message });
  }
});

/**
 * Verificar estado da conexão
 */
app.get('/connection-state/:clienteId', (req, res) => {
  const { clienteId } = req.params;
  
  const instance = instances.get(clienteId);
  
  if (!instance) {
    return res.json({
      connected: false,
      state: 'not_found',
      message: 'Nenhuma instância ativa'
    });
  }

  return res.json({
    connected: instance.state === 'open',
    state: instance.state,
    hasQR: !!instance.qrCode
  });
});

// ====================================
// INICIAR SERVIDOR
// ====================================

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('');
  console.log('╔══════════════════════════════════════════╗');
  console.log('║   🚀 MBNG WhatsApp Server ONLINE        ║');
  console.log('╚══════════════════════════════════════════╝');
  console.log('');
  console.log(`📡 Porta: ${PORT}`);
  console.log(`🔗 Supabase: ${SUPABASE_URL}`);
  console.log(`⏰ Iniciado em: ${new Date().toISOString()}`);
  console.log('');
  console.log('🎯 Endpoints disponíveis:');
  console.log('  GET  /health');
  console.log('  POST /generate-qr');
  console.log('  POST /disconnect');
  console.log('  GET  /connection-state/:clienteId');
  console.log('');
});

// ====================================
// GRACEFUL SHUTDOWN
// ====================================

process.on('SIGINT', async () => {
  console.log('');
  console.log('⚠️  Encerrando servidor...');
  
  // Desconectar todas as instâncias
  for (const [clienteId, instance] of instances.entries()) {
    try {
      console.log(`[${clienteId}] 👋 Desconectando...`);
      if (instance.sock) {
        await instance.sock.end();
      }
    } catch (error) {
      console.error(`[${clienteId}] ❌ Erro ao encerrar:`, error);
    }
  }
  
  console.log('✅ Servidor encerrado');
  process.exit(0);
});
