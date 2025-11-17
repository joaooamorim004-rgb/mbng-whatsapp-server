// WhatsApp Service - Coordenação Frontend (Evolution API inspired)
import { supabase } from '@/integrations/supabase/client';

interface WhatsAppConnectionState {
  qr?: string;
  connected: boolean;
  polling?: boolean;
}

class WhatsAppService {
  private static instance: WhatsAppService;
  private connections: Map<string, WhatsAppConnectionState> = new Map();
  private pollIntervals: Map<string, NodeJS.Timeout> = new Map();

  private constructor() {}

  static getInstance(): WhatsAppService {
    if (!WhatsAppService.instance) {
      WhatsAppService.instance = new WhatsAppService();
    }
    return WhatsAppService.instance;
  }

  async checkServerHealth(serverUrl: string): Promise<{ online: boolean; error?: string; details?: any }> {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 8000);
      
      const response = await fetch(`${serverUrl}/health`, {
        method: 'GET',
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        return { online: false, error: `Servidor retornou status ${response.status}` };
      }

      const data = await response.json();
      return { online: true, details: data };
      
    } catch (error: any) {
      if (error.name === 'AbortError') {
        return { online: false, error: 'Timeout - aguarde 1 minuto e tente novamente' };
      }
      return { online: false, error: 'Não foi possível conectar' };
    }
  }

  async requestQRCode(clienteId: string, serverUrl: string): Promise<string> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 25000);
    
    const response = await fetch(`${serverUrl}/generate-qr`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clienteId }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) throw new Error(`Erro ${response.status}`);

    const data = await response.json();
    if (!data.qr) throw new Error('QR não retornado');

    this.connections.set(clienteId, { qr: data.qr, connected: false });
    return data.qr;
  }

  startPolling(clienteId: string, onConnected: () => void): void {
    this.stopPolling(clienteId);

    const interval = setInterval(async () => {
      const { data } = await supabase
        .from('clientes_safe')
        .select('whatsapp_conectado')
        .eq('id', clienteId)
        .maybeSingle();

      if (data?.whatsapp_conectado) {
        this.stopPolling(clienteId);
        const state = this.connections.get(clienteId);
        if (state) state.connected = true;
        onConnected();
      }
    }, 2000);

    this.pollIntervals.set(clienteId, interval);
  }

  stopPolling(clienteId: string): void {
    const interval = this.pollIntervals.get(clienteId);
    if (interval) {
      clearInterval(interval);
      this.pollIntervals.delete(clienteId);
    }
  }

  async disconnect(clienteId: string): Promise<void> {
    this.stopPolling(clienteId);
    this.connections.delete(clienteId);
  }

  isConnected(clienteId: string): boolean {
    return this.connections.get(clienteId)?.connected || false;
  }

  getQRCode(clienteId: string): string | undefined {
    return this.connections.get(clienteId)?.qr;
  }
}

export const whatsappService = WhatsAppService.getInstance();
