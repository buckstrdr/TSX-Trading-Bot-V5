/**
 * TickAggregator - Converts raw market ticks into OHLC candlestick data
 * 
 * This service aggregates incoming price ticks into time-based candlesticks
 * for multiple symbols and timeframes. It's designed to be reusable across
 * different modules in the trading system.
 */

export interface MarketTick {
  symbol: string;
  price: number;
  volume: number;
  timestamp: number; // Unix timestamp in milliseconds
  bid?: number;
  ask?: number;
  side?: 'buy' | 'sell';
}

export interface Candlestick {
  symbol: string;
  timestamp: number; // Start time of the candle
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  trades: number; // Number of trades in this candle
  complete: boolean; // Whether this candle is complete
}

export type Timeframe = '1m' | '5m' | '15m' | '30m' | '1h' | '4h' | '1d';

export type CandleCallback = (candle: Candlestick) => void;

interface CandleBuffer {
  symbol: string;
  timeframe: Timeframe;
  startTime: number;
  endTime: number;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  volume: number;
  trades: number;
  ticks: MarketTick[];
}

export class TickAggregator {
  private buffers: Map<string, CandleBuffer> = new Map();
  private callbacks: Map<string, Set<CandleCallback>> = new Map();
  private timers: Map<string, NodeJS.Timeout> = new Map();
  
  // Timeframe durations in milliseconds
  private readonly timeframeDurations: Record<Timeframe, number> = {
    '1m': 60 * 1000,
    '5m': 5 * 60 * 1000,
    '15m': 15 * 60 * 1000,
    '30m': 30 * 60 * 1000,
    '1h': 60 * 60 * 1000,
    '4h': 4 * 60 * 60 * 1000,
    '1d': 24 * 60 * 60 * 1000
  };

  /**
   * Process an incoming market tick
   */
  public processTick(tick: MarketTick, timeframes: Timeframe[] = ['1m']): void {
    for (const timeframe of timeframes) {
      this.aggregateTick(tick, timeframe);
    }
  }

  /**
   * Subscribe to candle updates for a specific symbol and timeframe
   */
  public subscribe(symbol: string, timeframe: Timeframe, callback: CandleCallback): () => void {
    const key = this.getKey(symbol, timeframe);
    
    if (!this.callbacks.has(key)) {
      this.callbacks.set(key, new Set());
    }
    
    this.callbacks.get(key)!.add(callback);
    
    // Return unsubscribe function
    return () => {
      const callbacks = this.callbacks.get(key);
      if (callbacks) {
        callbacks.delete(callback);
        if (callbacks.size === 0) {
          this.callbacks.delete(key);
        }
      }
    };
  }

  /**
   * Get the current incomplete candle for a symbol and timeframe
   */
  public getCurrentCandle(symbol: string, timeframe: Timeframe): Candlestick | null {
    const key = this.getKey(symbol, timeframe);
    const buffer = this.buffers.get(key);
    
    if (!buffer || buffer.open === null) {
      return null;
    }
    
    return this.bufferToCandle(buffer, false);
  }

  /**
   * Get historical candles from memory (if available)
   */
  public getHistoricalCandles(symbol: string, timeframe: Timeframe, limit: number = 100): Candlestick[] {
    // This is a placeholder - in a real implementation, you'd store historical candles
    // For now, return empty array
    return [];
  }

  /**
   * Clear all data for a specific symbol
   */
  public clearSymbol(symbol: string): void {
    const keysToDelete: string[] = [];
    
    for (const [key] of this.buffers) {
      if (key.startsWith(`${symbol}:`)) {
        keysToDelete.push(key);
      }
    }
    
    for (const key of keysToDelete) {
      this.buffers.delete(key);
      this.callbacks.delete(key);
      
      const timer = this.timers.get(key);
      if (timer) {
        clearTimeout(timer);
        this.timers.delete(key);
      }
    }
  }

  /**
   * Clear all data
   */
  public clearAll(): void {
    this.buffers.clear();
    this.callbacks.clear();
    
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
  }

  private aggregateTick(tick: MarketTick, timeframe: Timeframe): void {
    const key = this.getKey(tick.symbol, timeframe);
    const duration = this.timeframeDurations[timeframe];
    const candleStartTime = this.getCandleStartTime(tick.timestamp, duration);
    const candleEndTime = candleStartTime + duration;
    
    let buffer = this.buffers.get(key);
    
    // Check if we need to start a new candle
    if (!buffer || tick.timestamp >= buffer.endTime) {
      // Complete the previous candle if it exists
      if (buffer && buffer.open !== null) {
        this.completeCandle(buffer);
      }
      
      // Create new buffer
      buffer = {
        symbol: tick.symbol,
        timeframe,
        startTime: candleStartTime,
        endTime: candleEndTime,
        open: null,
        high: null,
        low: null,
        close: null,
        volume: 0,
        trades: 0,
        ticks: []
      };
      
      this.buffers.set(key, buffer);
      
      // Set timer to complete candle at end time
      this.setCompletionTimer(key, buffer, candleEndTime);
    }
    
    // Update buffer with tick data
    if (buffer.open === null) {
      buffer.open = tick.price;
    }
    
    if (buffer.high === null || tick.price > buffer.high) {
      buffer.high = tick.price;
    }
    
    if (buffer.low === null || tick.price < buffer.low) {
      buffer.low = tick.price;
    }
    
    buffer.close = tick.price;
    buffer.volume += tick.volume;
    buffer.trades += 1;
    buffer.ticks.push(tick);
    
    // Emit incomplete candle update
    this.emitCandle(buffer, false);
  }

  private completeCandle(buffer: CandleBuffer): void {
    if (buffer.open === null) {
      return; // No data to complete
    }
    
    // Emit completed candle
    this.emitCandle(buffer, true);
    
    // Clear timer
    const key = this.getKey(buffer.symbol, buffer.timeframe);
    const timer = this.timers.get(key);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(key);
    }
  }

  private emitCandle(buffer: CandleBuffer, complete: boolean): void {
    const candle = this.bufferToCandle(buffer, complete);
    const key = this.getKey(buffer.symbol, buffer.timeframe);
    const callbacks = this.callbacks.get(key);
    
    if (callbacks) {
      for (const callback of callbacks) {
        try {
          callback(candle);
        } catch (error) {
          console.error(`Error in candle callback for ${key}:`, error);
        }
      }
    }
  }

  private bufferToCandle(buffer: CandleBuffer, complete: boolean): Candlestick {
    return {
      symbol: buffer.symbol,
      timestamp: buffer.startTime,
      open: buffer.open || 0,
      high: buffer.high || 0,
      low: buffer.low || 0,
      close: buffer.close || 0,
      volume: buffer.volume,
      trades: buffer.trades,
      complete
    };
  }

  private setCompletionTimer(key: string, buffer: CandleBuffer, endTime: number): void {
    // Clear existing timer if any
    const existingTimer = this.timers.get(key);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }
    
    const delay = endTime - Date.now();
    if (delay > 0) {
      const timer = setTimeout(() => {
        const currentBuffer = this.buffers.get(key);
        if (currentBuffer && currentBuffer.startTime === buffer.startTime) {
          this.completeCandle(currentBuffer);
        }
        this.timers.delete(key);
      }, delay);
      
      this.timers.set(key, timer);
    }
  }

  private getCandleStartTime(timestamp: number, duration: number): number {
    return Math.floor(timestamp / duration) * duration;
  }

  private getKey(symbol: string, timeframe: Timeframe): string {
    return `${symbol}:${timeframe}`;
  }

  /**
   * Get statistics about the aggregator
   */
  public getStats(): {
    activeSymbols: string[];
    activeBuffers: number;
    activeTimers: number;
    totalCallbacks: number;
  } {
    const activeSymbols = new Set<string>();
    
    for (const [key] of this.buffers) {
      const [symbol] = key.split(':');
      activeSymbols.add(symbol);
    }
    
    let totalCallbacks = 0;
    for (const callbacks of this.callbacks.values()) {
      totalCallbacks += callbacks.size;
    }
    
    return {
      activeSymbols: Array.from(activeSymbols),
      activeBuffers: this.buffers.size,
      activeTimers: this.timers.size,
      totalCallbacks
    };
  }
}

// Export a singleton instance for convenience
export const tickAggregator = new TickAggregator();