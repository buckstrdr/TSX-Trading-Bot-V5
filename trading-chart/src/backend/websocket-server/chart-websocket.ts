import { Server } from 'socket.io';
import http from 'http';

class ChartWebSocket {
  private io: Server;

  constructor(server: http.Server) {
    this.io = new Server(server, {
      cors: {
        origin: ["http://localhost:4676", "http://localhost:4675"],
        methods: ["GET", "POST"],
        credentials: true
      },
      transports: ['websocket', 'polling']
    });

    this.io.on('connection', (socket) => {
      console.log(`Client connected: ${socket.id}`);
      
      // Send initial connection confirmation
      socket.emit('connected', { message: 'Successfully connected to chart server' });

      socket.on('disconnect', (reason) => {
        console.log(`Client disconnected: ${socket.id}, reason: ${reason}`);
      });

      socket.on('error', (error) => {
        console.error(`Socket error for ${socket.id}:`, error);
      });

      // Handle subscription to specific symbols
      socket.on('subscribe', (symbol: string) => {
        console.log(`Client ${socket.id} subscribed to ${symbol}`);
        socket.join(`symbol:${symbol}`);
        socket.emit('subscribed', { symbol });
      });

      socket.on('unsubscribe', (symbol: string) => {
        console.log(`Client ${socket.id} unsubscribed from ${symbol}`);
        socket.leave(`symbol:${symbol}`);
        socket.emit('unsubscribed', { symbol });
      });
    });
  }

  public broadcast(event: string, data: any) {
    // Broadcast to all connected clients
    this.io.emit(event, data);
    
    // If data has a symbol, also broadcast to symbol-specific room
    if (data.symbol) {
      this.io.to(`symbol:${data.symbol}`).emit(`${event}:${data.symbol}`, data);
    }
  }

  public getConnectedClients(): number {
    return this.io.engine.clientsCount;
  }
}

export default ChartWebSocket;
