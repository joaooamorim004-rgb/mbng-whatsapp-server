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

// ========================================
// CONFIGURAÇÃO SUPABASE
// ========================================
const SUPABASE_URL = process.env.SUPABASE_URL || process.env.SUPABASEURL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASESERVICEROLEKEY;
const INTERNAL_API_SECRET = process.env.INTERNAL_API_SECRET || 'mudar-em-producao';

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('❌ SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY são obrigatórias');
  process.exit(1);
}

// ========================================
// LOGGING CONFIGURAÇÃO
// ========================================
const isDevelopment = process.env.NODE_ENV !== 'production';
const logger = pino({ 
  level: isDevelopment ? 'debug' : 'silent',
  transport: isDevelopment ? {
    target: 'pino-pretty',
    options: {
      colorize: true,
      translateTime: 'SYS:standard',
      ignore: 'pid,hostname'
    }
  } : undefined
});

console.log('');
console.log('╔══════════════════════════════════════════╗');
console.log('║   🚀 MBNG WhatsApp Server INICIANDO     ║');
console.log('╚══════════════════════════════════════════╝');
console.log(`📅 Data: ${new Date().toISOString()}`);
console.log(`🔧 Ambiente: ${process.env.NODE_ENV || 'development'}`);
console.log(`📡 Porta: ${process.env.PORT || 3000}`);
console.log(`🔗 Supabase: ${SUPABASE_URL ? '✅ Configurado' : '❌ Não configurado'}`);
console.log(`🔑 Service Key: ${SUPABASE_SERVICE_KEY ? '✅ Configurado' : '❌ Não configurado'}`);
console.log(`🔐 API Secret: ${INTERNAL_API_SECRET !== 'mudar-em-producao' ? '✅ Configurado' : '⚠️  USAR PADRÃO (INSEGURO)'}`);
console.log('');

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// Verificar conexão com Supabase na inicialização
(async () => {
  try {
    const { data, error } = await supabase
      .from('clientes')
      .select('id')
      .limit(1);
    
    if (error) {
      console.error('❌ ERRO ao conectar com Supabase:', error.message);
    } else {
      console.log('✅ Conexão com Supabase verificada');
    }
  } catch (err) {
    console.error('❌ EXCEÇÃO ao verificar Supabase:', err);
  }
})();

// Gerenciamento de instâncias
const instances = new Map();

// ========================================
// FUNÇÕES: Salvar/Carregar sessão do Supabase
// ========================================

async function saveAuthStateToSupabase(clienteId, creds, keys) {
  try {
    const { error } = await supabase
      .from('whatsapp_auth_state')
      .upsert({
        cliente_id: clienteId,
        creds: creds,
        keys: keys,
        updated_at: new Date().toISOString()
      }, {
        onConflict: 'cliente_id'
      });
    
    if (error) {
      console.error(`[${clienteId}] ❌ Erro ao salvar sessão no Supabase:`, error);
    } else {
      console.log(`[${clienteId}] ✅ Sessão salva no Supabase`);
    }
  } catch (err) {
    console.error(`[${clienteId}] ❌ Exceção ao salvar sessão:`, err);
  }
}

async function loadAuthStateFromSupabase(clienteId) {
  try {
    const { data, error } = await supabase
      .from('whatsapp_auth_state')
      .select('creds, keys')
      .eq('cliente_id', clienteId)
      .single();
    
    if (error || !data) {
      console.log(`[${clienteId}] 📝 Nenhuma sessão salva no Supabase`);
      return null;
    }
    
    console.log(`[${clienteId}] ✅ Sessão carregada do Supabase`);
    return { creds: data.creds, keys: data.keys };
  } catch (err) {
    console.error(`[${clienteId}] ❌ Erro ao carregar sessão:`, err);
    return null;
  }
}

// ========================================
// FUNÇÃO: Conectar ao WhatsApp
// ========================================

async function connectToWhatsApp(clienteId) {
  console.log(`[${clienteId}] 🔄 Iniciando conexão WhatsApp...`);
  
  const authDir = path.join(__dirname, 'auth_sessions', clienteId);
  
  // ✅ CORREÇÃO 2: Tentar carregar do Supabase primeiro
  const savedAuth = await loadAuthStateFromSupabase(clienteId);
  
  if (savedAuth) {
    // Restaurar sessão do Supabase para filesystem
    if (!fs.existsSync(authDir)) {
      fs.mkdirSync(authDir, { recursive: true });
    }
    fs.writeFileSync(
      path.join(authDir, 'creds.json'), 
      JSON.stringify(savedAuth.creds)
    );
    // Salvar keys também
    if (savedAuth.keys) {
      for (const [key, value] of Object.entries(savedAuth.keys)) {
        fs.writeFileSync(
          path.join(authDir, `${key}.json`),
          JSON.stringify(value)
        );
      }
    }
  } else {
    // Criar diretório se não existe sessão
    if (!fs.existsSync(authDir)) {
      fs.mkdirSync(authDir, { recursive: true });
    }
  }

  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  const { version } = await fetchLatestBaileysVersion();

  console.log(`[${clienteId}] 📦 Baileys version: ${version.join('.')}`);

  const sock = makeWASocket({
    version,
    logger,
    printQRInTerminal: false,
    auth: state,
    browser: Browsers.ubuntu('MBNG'),
    connectTimeoutMs: 60000,
    defaultQueryTimeoutMs: 0,
    keepAliveIntervalMs: 10000,
    markOnlineOnConnect: true,
    syncFullHistory: false,
    getMessage: async () => undefined
  });

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
    
    // ✅ CORREÇÃO 2: Salvar no Supabase também
    try {
      const credsFile = path.join(authDir, 'creds.json');
      if (fs.existsSync(credsFile)) {
        const creds = JSON.parse(fs.readFileSync(credsFile, 'utf8'));
        
        // Carregar todas as keys
        const keys = {};
        const files = fs.readdirSync(authDir);
        for (const file of files) {
          if (file !== 'creds.json' && file.endsWith('.json')) {
            const keyName = file.replace('.json', '');
            keys[keyName] = JSON.parse(
              fs.readFileSync(path.join(authDir, file), 'utf8')
            );
          }
        }
        
        await saveAuthStateToSupabase(clienteId, creds, keys);
      }
    } catch (err) {
      console.error(`[${clienteId}] ❌ Erro ao salvar no Supabase:`, err);
    }
  });

  // ====================================
  // EVENTO: ATUALIZAÇÃO DE CONEXÃO
  // ====================================
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    // QR Code gerado
    if (qr) {
      console.log(`[${clienteId}] 📱 QR Code gerado!`);
      instance.qrCode = qr;
      instance.state = 'qr_ready';
    }

    // Conectado com sucesso
    if (connection === 'open') {
      console.log(`[${clienteId}] ✅ WhatsApp CONECTADO!`);
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
    }

    // ✅ CORREÇÃO 7: Tratamento específico por DisconnectReason
    if (connection === 'close') {
      instance.state = 'close';
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      
      console.log(`[${clienteId}] ❌ Conexão fechada. Status: ${statusCode}`);
      
      switch (statusCode) {
        case DisconnectReason.loggedOut:
          console.log(`[${clienteId}] 🔐 Logout detectado - Limpando sessão`);
          // Limpar filesystem
          if (fs.existsSync(authDir)) {
            fs.rmSync(authDir, { recursive: true, force: true });
          }
          // Limpar Supabase
          await supabase
            .from('whatsapp_auth_state')
            .delete()
            .eq('cliente_id', clienteId);
          
          await supabase
            .from('clientes')
            .update({ whatsapp_conectado: false })
            .eq('id', clienteId);
          
          instances.delete(clienteId);
          break;
          
        case DisconnectReason.connectionClosed:
        case DisconnectReason.connectionLost:
          console.log(`[${clienteId}] 🔌 Conexão perdida - Reconectando...`);
          if (instance.retryCount < 5) {
            instance.retryCount++;
            const delay = Math.min(1000 * Math.pow(2, instance.retryCount), 30000);
            console.log(`[${clienteId}] ⏳ Aguardando ${delay}ms para reconectar`);
            setTimeout(() => connectToWhatsApp(clienteId), delay);
          } else {
            console.log(`[${clienteId}] ❌ Máximo de tentativas atingido`);
            instances.delete(clienteId);
            await supabase
              .from('clientes')
              .update({ whatsapp_conectado: false })
              .eq('id', clienteId);
          }
          break;
          
        case DisconnectReason.restartRequired:
          console.log(`[${clienteId}] 🔄 Restart requerido - Reiniciando...`);
          setTimeout(() => connectToWhatsApp(clienteId), 1000);
          break;
          
        case DisconnectReason.timedOut:
          console.log(`[${clienteId}] ⏰ Timeout - Tentando novamente...`);
          if (instance.retryCount < 3) {
            instance.retryCount++;
            setTimeout(() => connectToWhatsApp(clienteId), 5000);
          }
          break;
          
        default:
          console.log(`[${clienteId}] ❓ Motivo desconhecido: ${statusCode}`);
          const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
          if (shouldReconnect && instance.retryCount < 5) {
            instance.retryCount++;
            setTimeout(() => connectToWhatsApp(clienteId), 3000);
          } else {
            instances.delete(clienteId);
          }
      }
    }
  });

  // ====================================
  // EVENTO: MENSAGENS RECEBIDAS
  // ====================================
  sock.ev.on('messages.upsert', async ({ messages }) => {
    console.log(`[${clienteId}] 📨 ${messages.length} mensagem(ns) recebida(s)`);
    
    // ✅ CORREÇÃO 3: Salvar mensagens no Supabase
    for (const msg of messages) {
      if (!msg.message) continue;
      
      const phoneNumber = msg.key.remoteJid.replace('@s.whatsapp.net', '');
      const messageId = msg.key.id;
      const timestamp = new Date(msg.messageTimestamp * 1000);
      
      // Extrair conteúdo
      let content = '';
      let mediaUrl = null;
      let messageType = 'text';
      
      if (msg.message.conversation) {
        content = msg.message.conversation;
      } else if (msg.message.extendedTextMessage) {
        content = msg.message.extendedTextMessage.text;
      } else if (msg.message.imageMessage) {
        messageType = 'image';
        content = msg.message.imageMessage.caption || '';
      } else if (msg.message.videoMessage) {
        messageType = 'video';
        content = msg.message.videoMessage.caption || '';
      } else if (msg.message.documentMessage) {
        messageType = 'document';
        content = msg.message.documentMessage.fileName || '';
      } else if (msg.message.audioMessage) {
        messageType = 'audio';
      }
      
      console.log(`[${clienteId}] 💬 De: ${phoneNumber}, Tipo: ${messageType}, Texto: ${content}`);
      
      try {
        // 1. Upsert conversa
        const { data: conversa, error: conversaError } = await supabase
          .from('whatsapp_conversas')
          .upsert({
            cliente_id: clienteId,
            phone_number: phoneNumber,
            nome_contato: msg.pushName || phoneNumber,
            ultima_interacao_at: timestamp.toISOString(),
            total_mensagens: 1
          }, {
            onConflict: 'cliente_id,phone_number',
            returning: 'representation'
          })
          .select()
          .single();
        
        if (conversaError) {
          console.error(`[${clienteId}] ❌ Erro ao upsert conversa:`, conversaError);
          continue;
        }
        
        // 2. Inserir mensagem
        const { error: mensagemError } = await supabase
          .from('whatsapp_mensagens')
          .insert({
            conversa_id: conversa.id,
            mensagem_id: messageId,
            direcao: 'entrada',
            tipo: messageType,
            conteudo: content,
            media_url: mediaUrl,
            timestamp: timestamp.toISOString(),
            status: 'received'
          });
        
        if (mensagemError) {
          if (mensagemError.code === '23505') {
            console.log(`[${clienteId}] ℹ️ Mensagem ${messageId} já existe (duplicata)`);
          } else {
            console.error(`[${clienteId}] ❌ Erro ao inserir mensagem:`, mensagemError);
          }
        } else {
          console.log(`[${clienteId}] ✅ Mensagem salva no banco`);
          
          // 3. Atualizar última mensagem do cliente
          await supabase
            .from('clientes')
            .update({ ultima_mensagem_whatsapp_at: timestamp.toISOString() })
            .eq('id', clienteId);
        }
        
      } catch (err) {
        console.error(`[${clienteId}] ❌ Exceção ao salvar mensagem:`, err);
      }
    }
  });

  return instance;
}

// ========================================
// MIDDLEWARE: Validar requisições
// ========================================

function validateRequest(req, res, next) {
  // Permitir health check sem auth
  if (req.path === '/health') {
    return next();
  }
  
  const authHeader = req.headers['x-api-secret'] || req.headers['authorization'];
  
  if (!authHeader || authHeader !== INTERNAL_API_SECRET) {
    console.log('❌ Requisição não autorizada');
    return res.status(401).json({ error: 'Não autorizado' });
  }
  
  next();
}

// ✅ CORREÇÃO 5: Aplicar auth em todas as rotas exceto /health
app.use((req, res, next) => {
  if (req.path !== '/health') {
    return validateRequest(req, res, next);
  }
  next();
});

// ========================================
// ROTAS
// ========================================

app.get('/health', (req, res) => {
  res.json({
    status: 'online',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    instances: instances.size,
    memory: process.memoryUsage()
  });
});

app.post('/generate-qr', async (req, res) => {
  const { clienteId } = req.body;
  
  if (!clienteId) {
    return res.status(400).json({ error: 'clienteId obrigatório' });
  }

  console.log(`[${clienteId}] 🎯 Solicitação de QR Code`);

  try {
    let instance = instances.get(clienteId);
    
    // Se já conectado
    if (instance?.state === 'open') {
      console.log(`[${clienteId}] ✅ Já conectado, retornando sucesso`);
      return res.json({ success: true, connected: true });
    }
    
    // Se já tem QR válido
    if (instance?.qrCode && instance?.state === 'qr_ready') {
      console.log(`[${clienteId}] 📱 QR existente ainda válido`);
      return res.json({ qr: instance.qrCode });
    }

    // Se está conectando, aguardar
    if (instance?.state === 'connecting') {
      console.log(`[${clienteId}] ⏳ Já está conectando, aguardando...`);
    } else {
      // Criar nova instância
      console.log(`[${clienteId}] 🆕 Criando nova instância`);
      await connectToWhatsApp(clienteId);
      instance = instances.get(clienteId);
    }

    // ✅ CORREÇÃO 4: Timeout aumentado de 15s → 45s
    let attempts = 0;
    const maxAttempts = 90; // 90 * 500ms = 45 segundos
    
    while (attempts < maxAttempts) {
      await new Promise(resolve => setTimeout(resolve, 500));
      instance = instances.get(clienteId);
      
      // Se conectou durante a espera
      if (instance?.state === 'open') {
        console.log(`[${clienteId}] ✅ Conectado durante espera!`);
        return res.json({ success: true, connected: true });
      }
      
      // Se QR foi gerado
      if (instance?.qrCode && instance?.state === 'qr_ready') {
        console.log(`[${clienteId}] 📱 QR gerado após ${attempts * 0.5}s`);
        return res.json({ qr: instance.qrCode });
      }
      
      // Se houve erro crítico
      if (instance?.state === 'close' && instance?.retryCount >= 5) {
        console.log(`[${clienteId}] ❌ Falha crítica na conexão`);
        return res.status(500).json({ 
          error: 'Falha ao conectar após múltiplas tentativas' 
        });
      }
      
      attempts++;
    }

    console.log(`[${clienteId}] ⏰ Timeout após 45 segundos`);
    return res.status(408).json({ 
      error: 'Timeout ao gerar QR. Tente novamente.',
      attempts: attempts,
      state: instance?.state 
    });

  } catch (error) {
    console.error(`[${clienteId}] ❌ Erro:`, error);
    return res.status(500).json({ 
      error: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
});

app.post('/disconnect', async (req, res) => {
  const { clienteId } = req.body;
  
  if (!clienteId) {
    return res.status(400).json({ error: 'clienteId obrigatório' });
  }

  console.log(`[${clienteId}] 🔌 Solicitação de desconexão`);

  try {
    const instance = instances.get(clienteId);
    
    if (instance?.sock) {
      await instance.sock.logout();
      console.log(`[${clienteId}] ✅ Logout realizado`);
    }

    // Limpar filesystem
    const authDir = path.join(__dirname, 'auth_sessions', clienteId);
    if (fs.existsSync(authDir)) {
      fs.rmSync(authDir, { recursive: true, force: true });
      console.log(`[${clienteId}] 🗑️ Sessão removida do filesystem`);
    }

    // Limpar Supabase
    await supabase
      .from('whatsapp_auth_state')
      .delete()
      .eq('cliente_id', clienteId);

    await supabase
      .from('clientes')
      .update({ whatsapp_conectado: false })
      .eq('id', clienteId);

    instances.delete(clienteId);
    console.log(`[${clienteId}] ✅ Instância removida`);

    res.json({ success: true });
  } catch (error) {
    console.error(`[${clienteId}] ❌ Erro ao desconectar:`, error);
    res.status(500).json({ error: error.message });
  }
});

// ✅ CORREÇÃO 1: Corrigido typo inst.qrCode → instance.qrCode
app.get('/connection-state/:clienteId', (req, res) => {
  const { clienteId } = req.params;
  const instance = instances.get(clienteId);
  
  if (!instance) {
    return res.json({ connected: false, state: 'not_found' });
  }

  return res.json({
    connected: instance.state === 'open',
    state: instance.state,
    hasQR: !!instance.qrCode  // ✅ CORRIGIDO: instance.qrCode
  });
});

// ====================================
// INICIAR SERVIDOR
// ====================================

const PORT = process.env.PORT || 8080;

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('🚀 =======================================');
  console.log('🚀 MBNG WhatsApp Server ONLINE!');
  console.log('🚀 =======================================');
  console.log(`🚀 Porta: ${PORT}`);
  console.log(`🚀 URL: https://mbng-whatsapp-server-production.up.railway.app`);
  console.log('🚀 Endpoints:');
  console.log('🚀   GET  /health');
  console.log('🚀   POST /generate-qr');
  console.log('🚀   POST /disconnect');
  console.log('🚀   GET  /connection-state/:clienteId');
  console.log('🚀 =======================================');
  console.log('');
  console.log('✅ Pronto para receber requisições!');
});

server.on('error', (error) => {
  console.error('❌ ERRO AO INICIAR SERVIDOR:', error);
  process.exit(1);
});

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('\n🛑 SIGINT recebido, encerrando...');
  
  for (const [clienteId, instance] of instances.entries()) {
    try {
      if (instance.sock) {
        await instance.sock.logout();
        console.log(`[${clienteId}] ✅ Logout realizado`);
      }
    } catch (error) {
      console.error(`[${clienteId}] ❌ Erro ao fazer logout:`, error);
    }
  }
  
  process.exit(0);
});
