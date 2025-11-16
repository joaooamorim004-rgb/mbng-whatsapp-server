const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const { createClient } = require('@supabase/supabase-js');
const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// Usar as variáveis como estão no Lovable Cloud (sem underscores)
const SUPABASE_URL = process.env.SUPABASEURL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASESERVICEROLEKEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('❌ ERRO: Variáveis de ambiente não configuradas!');
  console.error('Configure no Railway:');
  console.error('- SUPABASEURL');
  console.error('- SUPABASESERVICEROLEKEY');
  process.exit(1);
}

console.log('✅ Variáveis de ambiente carregadas:');
console.log('- SUPABASEURL:', SUPABASE_URL);
console.log('- SUPABASESERVICEROLEKEY:', SUPABASE_SERVICE_KEY ? '***configurada***' : 'FALTANDO');

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// Armazena as conexões ativas
const activeConnections = new Map();

async function saveAuthState(clienteId, creds, keys) {
  try {
    const { error } = await supabase
      .from('whatsapp_auth_state')
      .upsert({
        cliente_id: clienteId,
        creds: creds,
        keys: keys,
        updated_at: new Date().toISOString()
      });

    if (error) {
      console.error('Erro ao salvar auth state:', error);
    } else {
      console.log('✅ Auth state salvo com sucesso para cliente:', clienteId);
    }
  } catch (error) {
    console.error('Erro ao salvar auth state:', error);
  }
}

async function loadAuthState(clienteId) {
  try {
    const { data, error } = await supabase
      .from('whatsapp_auth_state')
      .select('creds, keys')
      .eq('cliente_id', clienteId)
      .single();

    if (error || !data) {
      console.log('Nenhum auth state encontrado para cliente:', clienteId);
      return null;
    }

    console.log('✅ Auth state carregado do banco para cliente:', clienteId);
    return data;
  } catch (error) {
    console.error('Erro ao carregar auth state:', error);
    return null;
  }
}

async function createWhatsAppConnection(clienteId) {
  console.log('🔄 Iniciando conexão WhatsApp para cliente:', clienteId);

  try {
    const savedAuth = await loadAuthState(clienteId);
    
    let authState;
    if (savedAuth) {
      authState = {
        state: {
          creds: savedAuth.creds,
          keys: savedAuth.keys
        },
        saveCreds: async () => {
          await saveAuthState(clienteId, authState.state.creds, authState.state.keys);
        }
      };
    } else {
      const { state, saveCreds } = await useMultiFileAuthState(`./auth_${clienteId}`);
      authState = { state, saveCreds };
    }

    const sock = makeWASocket({
      auth: authState.state,
      printQRInTerminal: false,
    });

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        console.log('📱 QR Code gerado para cliente:', clienteId);
        activeConnections.set(clienteId, { qr, sock, connected: false });
      }

      if (connection === 'close') {
        const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
        console.log('❌ Conexão fechada. Reconectar?', shouldReconnect);

        await supabase
          .from('clientes')
          .update({ 
            whatsapp_conectado: false,
            updated_at: new Date().toISOString()
          })
          .eq('id', clienteId);

        activeConnections.delete(clienteId);

        if (shouldReconnect) {
          setTimeout(() => createWhatsAppConnection(clienteId), 3000);
        }
      }

      if (connection === 'open') {
        console.log('✅ WhatsApp conectado para cliente:', clienteId);
        
        await saveAuthState(clienteId, sock.authState.creds, sock.authState.keys);
        
        await supabase
          .from('clientes')
          .update({ 
            whatsapp_conectado: true,
            updated_at: new Date().toISOString()
          })
          .eq('id', clienteId);

        const connData = activeConnections.get(clienteId);
        if (connData) {
          connData.connected = true;
          activeConnections.set(clienteId, connData);
        }
      }
    });

    sock.ev.on('messages.upsert', async ({ messages }) => {
      for (const message of messages) {
        if (!message.key.fromMe) {
          await processMessage(clienteId, message);
        }
      }
    });

    return sock;
  } catch (error) {
    console.error('Erro ao criar conexão WhatsApp:', error);
    throw error;
  }
}

async function processMessage(clienteId, message) {
  try {
    const phoneNumber = message.key.remoteJid.replace('@s.whatsapp.net', '');
    const messageText = message.message?.conversation || 
                       message.message?.extendedTextMessage?.text || '';
    const messageType = message.message?.imageMessage ? 'image' :
                       message.message?.videoMessage ? 'video' :
                       message.message?.documentMessage ? 'document' :
                       message.message?.audioMessage ? 'audio' : 'text';

    console.log('📥 Processando mensagem:', {
      clienteId,
      phoneNumber,
      messageType,
      text: messageText.substring(0, 50)
    });

    const { error } = await supabase.functions.invoke('whatsapp-webhook', {
      body: {
        clienteId,
        phoneNumber,
        messageText,
        messageType,
        messageId: message.key.id,
        timestamp: message.messageTimestamp
      }
    });

    if (error) {
      console.error('Erro ao processar mensagem via edge function:', error);
    }
  } catch (error) {
    console.error('Erro ao processar mensagem:', error);
  }
}

app.post('/generate-qr', async (req, res) => {
  try {
    const { clienteId } = req.body;

    if (!clienteId) {
      return res.status(400).json({ error: 'clienteId é obrigatório' });
    }

    console.log('📱 Requisição para gerar QR Code:', clienteId);

    if (activeConnections.has(clienteId)) {
      const existingConn = activeConnections.get(clienteId);
      if (existingConn.connected) {
        return res.json({ message: 'Já conectado', connected: true });
      }
      if (existingConn.qr) {
        return res.json({ qr: existingConn.qr });
      }
    }

    const sock = await createWhatsAppConnection(clienteId);

    const waitForQR = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Timeout ao aguardar QR code'));
      }, 30000);

      const checkQR = setInterval(() => {
        const conn = activeConnections.get(clienteId);
        if (conn?.qr) {
          clearInterval(checkQR);
          clearTimeout(timeout);
          resolve(conn.qr);
        }
      }, 500);
    });

    const qr = await waitForQR;
    res.json({ qr });

  } catch (error) {
    console.error('Erro ao gerar QR code:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok',
    supabaseConfigured: !!(SUPABASE_URL && SUPABASE_SERVICE_KEY),
    activeConnections: activeConnections.size
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Servidor WhatsApp rodando na porta ${PORT}`);
});
