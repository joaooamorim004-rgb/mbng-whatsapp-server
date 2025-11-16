const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const { createClient } = require('@supabase/supabase-js');
const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// Usar as variáveis com underscores como configurado no Lovable Cloud
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('❌ ERRO: Variáveis de ambiente não configuradas!');
  console.error('Configure no Railway:');
  console.error('- SUPABASE_URL');
  console.error('- SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

console.log('✅ Variáveis de ambiente carregadas:');
console.log('- SUPABASE_URL:', SUPABASE_URL);
console.log('- SUPABASE_SERVICE_ROLE_KEY:', SUPABASE_SERVICE_KEY ? '***configurada***' : 'FALTANDO');

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
    // Carregar estado de autenticação do banco
    const savedAuth = await loadAuthState(clienteId);
    
    let authState;
    if (savedAuth) {
      // Usar credenciais salvas
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
      // Criar novas credenciais
      const { state, saveCreds } = await useMultiFileAuthState(`./auth_${clienteId}`);
      authState = { state, saveCreds };
    }

    const sock = makeWASocket({
      auth: authState.state,
      printQRInTerminal: false,
    });

    // Salvar QR Code
    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        console.log('📱 QR Code gerado para cliente:', clienteId);
        activeConnections.set(clienteId, { qr, sock, connected: false });
      }

      if (connection === 'close') {
        const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
        console.log('❌ Conexão fechada. Reconectar?', shouldReconnect);

        // Atualizar status no banco
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
      } else if (connection === 'open') {
        console.log('✅ WhatsApp conectado para cliente:', clienteId);
        
        // Salvar credenciais
        await authState.saveCreds();

        // Atualizar status no banco
        await supabase
          .from('clientes')
          .update({ 
            whatsapp_conectado: true,
            updated_at: new Date().toISOString()
          })
          .eq('id', clienteId);

        const connection = activeConnections.get(clienteId);
        if (connection) {
          connection.connected = true;
          activeConnections.set(clienteId, connection);
        }
      }
    });

    // Processar mensagens recebidas
    sock.ev.on('messages.upsert', async ({ messages }) => {
      for (const message of messages) {
        if (message.key.fromMe) continue;

        try {
          await processMessage(clienteId, message);
        } catch (error) {
          console.error('Erro ao processar mensagem:', error);
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
  console.log('📨 Processando mensagem para cliente:', clienteId);

  const phoneNumber = message.key.remoteJid.replace('@s.whatsapp.net', '');
  const messageContent = message.message?.conversation || 
                        message.message?.extendedTextMessage?.text || 
                        '';

  const messageData = {
    phone_number: phoneNumber,
    content: messageContent,
    timestamp: new Date(message.messageTimestamp * 1000).toISOString(),
    message_id: message.key.id,
    type: 'text',
    direction: 'entrada'
  };

  try {
    // Enviar para edge function processar
    const { error } = await supabase.functions.invoke('whatsapp-webhook', {
      body: {
        cliente_id: clienteId,
        message_data: messageData
      }
    });

    if (error) {
      console.error('Erro ao enviar mensagem para webhook:', error);
    } else {
      console.log('✅ Mensagem enviada para webhook com sucesso');
    }
  } catch (error) {
    console.error('Erro ao processar mensagem:', error);
  }
}

// Endpoint para gerar QR Code
app.post('/generate-qr', async (req, res) => {
  try {
    const { clienteId } = req.body;

    if (!clienteId) {
      return res.status(400).json({ error: 'clienteId é obrigatório' });
    }

    console.log('📱 Solicitação de QR code para cliente:', clienteId);

    // Verificar se já existe uma conexão ativa
    let connection = activeConnections.get(clienteId);

    if (!connection || !connection.qr) {
      // Criar nova conexão
      await createWhatsAppConnection(clienteId);
      
      // Aguardar QR code ser gerado (timeout de 30 segundos)
      let attempts = 0;
      while (attempts < 30) {
        connection = activeConnections.get(clienteId);
        if (connection && connection.qr) {
          break;
        }
        await new Promise(resolve => setTimeout(resolve, 1000));
        attempts++;
      }

      if (!connection || !connection.qr) {
        return res.status(500).json({ error: 'Timeout ao gerar QR code' });
      }
    }

    console.log('✅ QR code pronto para cliente:', clienteId);
    res.json({ qr: connection.qr });
  } catch (error) {
    console.error('Erro ao gerar QR code:', error);
    res.status(500).json({ error: error.message });
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'online',
    activeConnections: activeConnections.size,
    environment: {
      supabase_url: SUPABASE_URL ? '✅ configurada' : '❌ faltando',
      supabase_key: SUPABASE_SERVICE_KEY ? '✅ configurada' : '❌ faltando'
    }
  });
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`🚀 Servidor WhatsApp rodando na porta ${PORT}`);
  console.log(`📊 Health check: http://localhost:${PORT}/health`);
});
