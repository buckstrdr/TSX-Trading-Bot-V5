import Redis from 'ioredis';

interface RedisConfig {
  host?: string;
  port?: number;
  password?: string;
  db?: number;
  retryStrategy?: (times: number) => number | void;
}

class RedisSubscriber {
  private redis: Redis;
  private channels: Set<string> = new Set();
  private isConnected: boolean = false;

  constructor(config?: RedisConfig) {
    const defaultConfig: RedisConfig = {
      host: process.env.REDIS_HOST || 'localhost',
      port: parseInt(process.env.REDIS_PORT || '6379'),
      password: process.env.REDIS_PASSWORD,
      db: parseInt(process.env.REDIS_DB || '0'),
      retryStrategy: (times: number) => {
        const delay = Math.min(times * 50, 2000);
        console.log(`Retrying Redis connection in ${delay}ms...`);
        return delay;
      }
    };

    this.redis = new Redis({ ...defaultConfig, ...config });

    // Handle connection events
    this.redis.on('connect', () => {
      console.log('Connected to Redis');
      this.isConnected = true;
    });

    this.redis.on('ready', () => {
      console.log('Redis connection ready');
      // Resubscribe to channels after reconnection
      this.channels.forEach(channel => {
        this.redis.subscribe(channel);
      });
    });

    this.redis.on('error', (err) => {
      console.error('Redis connection error:', err);
      this.isConnected = false;
    });

    this.redis.on('close', () => {
      console.log('Redis connection closed');
      this.isConnected = false;
    });
  }

  private messageHandlers: Map<string, (message: string) => void> = new Map();
  
  public async subscribe(channel: string, callback: (message: string) => void): Promise<void> {
    try {
      this.channels.add(channel);
      this.messageHandlers.set(channel, callback);
      
      await this.redis.subscribe(channel);
      console.log(`Subscribed to channel: ${channel}`);

      // Set up the message handler only once
      if (this.messageHandlers.size === 1) {
        this.redis.on('message', (ch: string, message: string) => {
          const handler = this.messageHandlers.get(ch);
          if (handler) {
            try {
              handler(message);
            } catch (error) {
              console.error(`Error processing message from channel ${ch}:`, error);
            }
          }
        });
      }
    } catch (error) {
      console.error(`Failed to subscribe to channel ${channel}:`, error);
      throw error;
    }
  }

  public async unsubscribe(channel: string): Promise<void> {
    try {
      await this.redis.unsubscribe(channel);
      this.channels.delete(channel);
      this.messageHandlers.delete(channel);
      console.log(`Unsubscribed from channel: ${channel}`);
    } catch (error) {
      console.error(`Failed to unsubscribe from channel ${channel}:`, error);
    }
  }

  public isHealthy(): boolean {
    return this.isConnected && this.redis.status === 'ready';
  }

  public async close(): Promise<void> {
    await this.redis.quit();
  }
}

export default RedisSubscriber;
