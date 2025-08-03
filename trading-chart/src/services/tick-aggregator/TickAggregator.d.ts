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
    timestamp: number;
    bid?: number;
    ask?: number;
    side?: 'buy' | 'sell';
}
export interface Candlestick {
    symbol: string;
    timestamp: number;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
    trades: number;
    complete: boolean;
}
export type Timeframe = '1m' | '5m' | '15m' | '30m' | '1h' | '4h' | '1d';
export type CandleCallback = (candle: Candlestick) => void;
export declare class TickAggregator {
    private buffers;
    private callbacks;
    private timers;
    private readonly timeframeDurations;
    /**
     * Process an incoming market tick
     */
    processTick(tick: MarketTick, timeframes?: Timeframe[]): void;
    /**
     * Subscribe to candle updates for a specific symbol and timeframe
     */
    subscribe(symbol: string, timeframe: Timeframe, callback: CandleCallback): () => void;
    /**
     * Get the current incomplete candle for a symbol and timeframe
     */
    getCurrentCandle(symbol: string, timeframe: Timeframe): Candlestick | null;
    /**
     * Get historical candles from memory (if available)
     */
    getHistoricalCandles(symbol: string, timeframe: Timeframe, limit?: number): Candlestick[];
    /**
     * Clear all data for a specific symbol
     */
    clearSymbol(symbol: string): void;
    /**
     * Clear all data
     */
    clearAll(): void;
    private aggregateTick;
    private completeCandle;
    private emitCandle;
    private bufferToCandle;
    private setCompletionTimer;
    private getCandleStartTime;
    private getKey;
    /**
     * Get statistics about the aggregator
     */
    getStats(): {
        activeSymbols: string[];
        activeBuffers: number;
        activeTimers: number;
        totalCallbacks: number;
    };
}
export declare const tickAggregator: TickAggregator;
//# sourceMappingURL=TickAggregator.d.ts.map