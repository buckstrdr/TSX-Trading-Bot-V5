import { io, Socket } from 'socket.io-client';

class WebSocketClient {
  private socket: Socket;

  constructor() {
    // Connect with explicit options
    this.socket = io('http://localhost:4675', {
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
      reconnectionAttempts: Infinity
    });
    
    // Add connection debugging
    this.socket.on('connect', () => {
      console.log('WebSocket connected to chart server');
    });
    
    this.socket.on('connect_error', (error) => {
      console.error('WebSocket connection error:', error);
    });
    
    this.socket.on('disconnect', (reason) => {
      console.log('WebSocket disconnected:', reason);
    });
  }

  public on(event: string, callback: (data: any) => void) {
    this.socket.on(event, callback);
  }
  
  public emit(event: string, data: any) {
    this.socket.emit(event, data);
  }
  
  public get connected(): boolean {
    return this.socket.connected;
  }
}

export default WebSocketClient;
