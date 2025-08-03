import React, { useEffect, useRef, useState } from 'react';
import { createChart, IChartApi, ISeriesApi, CandlestickData, UTCTimestamp, LineData, IPriceLine } from 'lightweight-charts';
import WebSocketClient from '../services/websocket-client';

interface MarketTick {
  symbol: string;
  price: number;
  volume: number;
  timestamp: number;
  bid?: number;
  ask?: number;
  side?: 'buy' | 'sell';
}

interface CandlestickUpdate {
  symbol: string;
  timeframe: string;
  candle: {
    time: number;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
  };
  complete: boolean;
  trades: number;
}

interface TradeExecution {
  symbol: string;
  price: number;
  quantity: number;
  side: 'buy' | 'sell';
  timestamp: number;
}

interface Position {
  accountId: string;
  positionId: string;
  instrument: string;
  type: 'LONG' | 'SHORT';
  size: number;
  averagePrice: number;
  unrealizedPnL?: number;
  realizedPnL?: number;
  timestamp: number;
}

interface OrderFill {
  orderId: string;
  accountId: string;
  instrument: string;
  side: 'BUY' | 'SELL';
  filledPrice: number;
  filledQuantity: number;
  positionId?: string;
  timestamp: number;
}

interface StopLossTakeProfit {
  positionId: string;
  stopLoss?: number;
  takeProfit?: number;
  instrument: string;
}

const Chart: React.FC = () => {
  const chartContainerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candlestickSeriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const priceLineRef = useRef<ISeriesApi<"Line"> | null>(null);
  const volumeSeriesRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  
  // Position and order tracking
  const positionLinesRef = useRef<Map<string, IPriceLine>>(new Map());
  const stopLossLinesRef = useRef<Map<string, IPriceLine>>(new Map());
  const takeProfitLinesRef = useRef<Map<string, IPriceLine>>(new Map());
  
  const [symbol, setSymbol] = useState<string>('');
  const [connectionStatus, setConnectionStatus] = useState<'connecting' | 'connected' | 'disconnected'>('connecting');
  const [currentPrice, setCurrentPrice] = useState<number | null>(null);
  const [selectedTimeframe, setSelectedTimeframe] = useState<string>('1m');
  const [tradeCount, setTradeCount] = useState<number>(0);
  const [isLoadingHistory, setIsLoadingHistory] = useState<boolean>(false);
  
  // Position and order state
  const [positions, setPositions] = useState<Map<string, Position>>(new Map());
  const [orderFills, setOrderFills] = useState<OrderFill[]>([]);
  const [stopLossTakeProfit, setStopLossTakeProfit] = useState<Map<string, StopLossTakeProfit>>(new Map());

  // Load historical data for a symbol and timeframe
  const loadHistoricalData = async (symbolToLoad: string, timeframe: string) => {
    if (!candlestickSeriesRef.current) return;
    
    setIsLoadingHistory(true);
    try {
      const response = await fetch(`/api/historical/${symbolToLoad}/${timeframe}?bars=100`);
      if (response.ok) {
        const data = await response.json();
        
        // Clear existing data and add historical bars
        candlestickSeriesRef.current.setData(data.bars.map((bar: any) => ({
          time: bar.time as UTCTimestamp,
          open: bar.open,
          high: bar.high,
          low: bar.low,
          close: bar.close
        })));
        
        console.log(`Loaded ${data.bars.length} historical bars for ${symbolToLoad} ${timeframe}`);
      }
    } catch (error) {
      console.error('Error loading historical data:', error);
    } finally {
      setIsLoadingHistory(false);
    }
  };
  
  // Position Management Functions
  const addPositionLine = (position: Position) => {
    if (!chartRef.current || position.instrument !== symbol) return;
    
    const color = position.type === 'LONG' ? '#26a69a' : '#ef5350';
    const title = `${position.type} ${position.size} @ $${position.averagePrice.toFixed(2)}`;
    
    const priceLine = chartRef.current.addPriceLine({
      price: position.averagePrice,
      color: color,
      lineWidth: 2,
      lineStyle: 0, // Solid
      axisLabelVisible: true,
      title: title,
    });
    
    positionLinesRef.current.set(position.positionId, priceLine);
    console.log(`📊 Added position line for ${position.positionId}: ${title}`);
  };
  
  const removePositionLine = (positionId: string) => {
    const line = positionLinesRef.current.get(positionId);
    if (line && chartRef.current) {
      chartRef.current.removePriceLine(line);
      positionLinesRef.current.delete(positionId);
      console.log(`📊 Removed position line for ${positionId}`);
    }
  };
  
  const addStopLossLine = (positionId: string, stopLoss: number, instrument: string) => {
    if (!chartRef.current || instrument !== symbol) return;
    
    const priceLine = chartRef.current.addPriceLine({
      price: stopLoss,
      color: '#ff4444',
      lineWidth: 1,
      lineStyle: 2, // Dashed
      axisLabelVisible: true,
      title: `SL: $${stopLoss.toFixed(2)}`,
    });
    
    stopLossLinesRef.current.set(positionId, priceLine);
    console.log(`🛑 Added stop loss line for ${positionId}: $${stopLoss.toFixed(2)}`);
  };
  
  const addTakeProfitLine = (positionId: string, takeProfit: number, instrument: string) => {
    if (!chartRef.current || instrument !== symbol) return;
    
    const priceLine = chartRef.current.addPriceLine({
      price: takeProfit,
      color: '#44ff44',
      lineWidth: 1,
      lineStyle: 2, // Dashed
      axisLabelVisible: true,
      title: `TP: $${takeProfit.toFixed(2)}`,
    });
    
    takeProfitLinesRef.current.set(positionId, priceLine);
    console.log(`🎯 Added take profit line for ${positionId}: $${takeProfit.toFixed(2)}`);
  };
  
  const removeStopLossTakeProfitLines = (positionId: string) => {
    // Remove stop loss line
    const slLine = stopLossLinesRef.current.get(positionId);
    if (slLine && chartRef.current) {
      chartRef.current.removePriceLine(slLine);
      stopLossLinesRef.current.delete(positionId);
    }
    
    // Remove take profit line
    const tpLine = takeProfitLinesRef.current.get(positionId);
    if (tpLine && chartRef.current) {
      chartRef.current.removePriceLine(tpLine);
      takeProfitLinesRef.current.delete(positionId);
    }
  };
  
  const addOrderFillMarker = (fill: OrderFill) => {
    if (!candlestickSeriesRef.current || fill.instrument !== symbol) return;
    
    const time = Math.floor(fill.timestamp / 1000) as UTCTimestamp;
    const color = fill.side === 'BUY' ? '#26a69a' : '#ef5350';
    const shape = fill.side === 'BUY' ? 'arrowUp' : 'arrowDown';
    const position = fill.side === 'BUY' ? 'belowBar' : 'aboveBar';
    
    candlestickSeriesRef.current.setMarkers([{
      time: time,
      position: position,
      color: color,
      shape: shape,
      text: `${fill.side} ${fill.filledQuantity} @ $${fill.filledPrice.toFixed(2)}`,
      size: 1,
    }]);
    
    console.log(`📈 Added order fill marker: ${fill.side} ${fill.filledQuantity} @ $${fill.filledPrice.toFixed(2)}`);
  };
  
  // Store candles by timeframe
  const candlesByTimeframe = useRef<Map<string, Map<number, CandlestickData>>>(new Map());

  useEffect(() => {
    if (chartContainerRef.current && !chartRef.current) {
      // Create chart with proper configuration
      chartRef.current = createChart(chartContainerRef.current, {
        width: chartContainerRef.current.clientWidth,
        height: 600,
        layout: {
          background: { color: '#1e1e1e' },
          textColor: '#d1d5db',
        },
        grid: {
          vertLines: { color: '#2d2d2d' },
          horzLines: { color: '#2d2d2d' },
        },
        timeScale: {
          timeVisible: true,
          secondsVisible: false,
          rightOffset: 5,
        },
        rightPriceScale: {
          borderColor: '#2d2d2d',
        },
      });

      // Create candlestick series
      candlestickSeriesRef.current = chartRef.current.addCandlestickSeries({
        upColor: '#26a69a',
        downColor: '#ef5350',
        borderUpColor: '#26a69a',
        borderDownColor: '#ef5350',
        wickUpColor: '#26a69a',
        wickDownColor: '#ef5350',
        priceFormat: {
          type: 'price',
          precision: 2,
          minMove: 0.01,
        },
      });

      // Create volume series
      volumeSeriesRef.current = chartRef.current.addHistogramSeries({
        color: '#26a69a',
        priceFormat: {
          type: 'volume',
        },
        priceScaleId: '',
      });

      // Create price line for current price
      priceLineRef.current = chartRef.current.addLineSeries({
        color: '#2962ff',
        lineWidth: 1,
        priceFormat: {
          type: 'price',
          precision: 2,
          minMove: 0.01,
        },
        crosshairMarkerVisible: false,
        lastValueVisible: false,
      });

      // Set up WebSocket connection
      const websocketClient = new WebSocketClient();
      
      websocketClient.on('connect', () => {
        setConnectionStatus('connected');
        console.log('Connected to chart server');
        
        // Subscribe to default symbols if we don't have one yet
        if (!symbol) {
          console.log('Subscribing to default symbols...');
          const defaultSymbol = 'CON.F.US.MNQ.U25';
          websocketClient.emit('subscribe', defaultSymbol); // Nasdaq futures
          websocketClient.emit('subscribe', 'CON.F.US.MES.U25'); // S&P futures
          websocketClient.emit('subscribe', 'CON.F.US.MGC.Q25'); // Gold futures
          
          // Load historical data for the default symbol
          loadHistoricalData(defaultSymbol, selectedTimeframe);
          setSymbol(defaultSymbol);
        }
      });

      websocketClient.on('disconnect', () => {
        setConnectionStatus('disconnected');
        console.log('Disconnected from chart server');
      });

      // Handle candlestick updates from aggregator
      websocketClient.on('candlestick-update', (data: CandlestickUpdate) => {
        if (candlestickSeriesRef.current && (data.symbol === symbol || !symbol)) {
          // Update symbol if not set
          if (!symbol && data.symbol) {
            setSymbol(data.symbol);
          }
          
          // Store candles by timeframe
          if (!candlesByTimeframe.current.has(data.timeframe)) {
            candlesByTimeframe.current.set(data.timeframe, new Map());
          }
          
          const timeframeCandles = candlesByTimeframe.current.get(data.timeframe)!;
          const candlestickData: CandlestickData = {
            time: data.candle.time as UTCTimestamp,
            open: data.candle.open,
            high: data.candle.high,
            low: data.candle.low,
            close: data.candle.close,
          };
          
          timeframeCandles.set(data.candle.time, candlestickData);
          
          // Update chart if this is the selected timeframe
          if (data.timeframe === selectedTimeframe) {
            candlestickSeriesRef.current.update(candlestickData);
            
            // Update volume
            if (volumeSeriesRef.current) {
              volumeSeriesRef.current.update({
                time: data.candle.time as UTCTimestamp,
                value: data.candle.volume,
                color: data.candle.close >= data.candle.open ? '#26a69a' : '#ef5350',
              });
            }
          }
          
          // Update trade count if complete
          if (data.complete) {
            setTradeCount(prev => prev + data.trades);
          }
        }
      });

      // Handle real-time tick data
      websocketClient.on('market-tick', (tick: MarketTick) => {
        if (tick.symbol === symbol || !symbol) {
          setCurrentPrice(tick.price);
          
          // Update symbol if not set
          if (!symbol) {
            setSymbol(tick.symbol);
          }
          
          // Also update from candlestick data
          if (!symbol && tick.symbol) {
            setSymbol(tick.symbol);
          }
          
          // Update price line
          if (priceLineRef.current) {
            const time = Math.floor(tick.timestamp / 1000) as UTCTimestamp;
            priceLineRef.current.update({
              time,
              value: tick.price,
            });
          }
        }
      });

      // Handle trade executions
      websocketClient.on('trade-execution', (execution: TradeExecution) => {
        if (execution.symbol === symbol) {
          // Could add markers on the chart for executed trades
          console.log('Trade executed:', execution);
        }
      });

      // Handle system alerts
      websocketClient.on('system-alert', (alert: any) => {
        console.log('System alert:', alert);
        // Could display alerts in the UI
      });

      // Handle position updates
      websocketClient.on('position-update', (positionData: Position) => {
        console.log('Position update received:', positionData);
        
        if (positionData.instrument === symbol) {
          setPositions(prev => {
            const newPositions = new Map(prev);
            
            if (positionData.size === 0) {
              // Position closed, remove lines
              removePositionLine(positionData.positionId);
              removeStopLossTakeProfitLines(positionData.positionId);
              newPositions.delete(positionData.positionId);
            } else {
              // Position opened or updated
              const existingPosition = newPositions.get(positionData.positionId);
              if (!existingPosition) {
                // New position, add line
                addPositionLine(positionData);
              }
              newPositions.set(positionData.positionId, positionData);
            }
            
            return newPositions;
          });
        }
      });

      // Handle order fills
      websocketClient.on('order-fill', (fillData: OrderFill) => {
        console.log('Order fill received:', fillData);
        
        if (fillData.instrument === symbol) {
          setOrderFills(prev => [...prev, fillData]);
          addOrderFillMarker(fillData);
        }
      });

      // Handle stop loss and take profit updates
      websocketClient.on('sl-tp-update', (slTpData: StopLossTakeProfit) => {
        console.log('SL/TP update received:', slTpData);
        
        if (slTpData.instrument === symbol) {
          setStopLossTakeProfit(prev => {
            const newSlTp = new Map(prev);
            
            // Remove existing lines
            removeStopLossTakeProfitLines(slTpData.positionId);
            
            // Add new lines if values exist
            if (slTpData.stopLoss) {
              addStopLossLine(slTpData.positionId, slTpData.stopLoss, slTpData.instrument);
            }
            if (slTpData.takeProfit) {
              addTakeProfitLine(slTpData.positionId, slTpData.takeProfit, slTpData.instrument);
            }
            
            newSlTp.set(slTpData.positionId, slTpData);
            return newSlTp;
          });
        }
      });

      // Handle window resize
      const handleResize = () => {
        if (chartRef.current && chartContainerRef.current) {
          chartRef.current.applyOptions({
            width: chartContainerRef.current.clientWidth,
          });
        }
      };
      window.addEventListener('resize', handleResize);

      return () => {
        window.removeEventListener('resize', handleResize);
        if (chartRef.current) {
          chartRef.current.remove();
          chartRef.current = null;
        }
      };
    }
  }, [symbol, selectedTimeframe]);

  // Update chart when timeframe changes
  useEffect(() => {
    if (candlestickSeriesRef.current && volumeSeriesRef.current) {
      // Clear existing data
      candlestickSeriesRef.current.setData([]);
      volumeSeriesRef.current.setData([]);
      
      // Load data for selected timeframe
      const timeframeCandles = candlesByTimeframe.current.get(selectedTimeframe);
      if (timeframeCandles) {
        const sortedCandles = Array.from(timeframeCandles.values()).sort((a, b) => 
          (a.time as number) - (b.time as number)
        );
        candlestickSeriesRef.current.setData(sortedCandles);
        
        // Update volume data
        const volumeData = sortedCandles.map(candle => ({
          time: candle.time,
          value: 0, // We don't have volume in the candle data structure
          color: (candle.close || 0) >= (candle.open || 0) ? '#26a69a' : '#ef5350',
        }));
        volumeSeriesRef.current.setData(volumeData);
      }
    }
  }, [selectedTimeframe]);

  return (
    <div style={{ width: '100%', height: '100vh', backgroundColor: '#1e1e1e' }}>
      <div style={{ padding: '10px', color: '#d1d5db', borderBottom: '1px solid #2d2d2d' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '20px' }}>
            <h2 style={{ margin: 0 }}>
              {symbol || 'Waiting for data...'} 
              {currentPrice && (
                <span style={{ 
                  fontSize: '18px', 
                  marginLeft: '10px',
                  color: currentPrice > 0 ? '#26a69a' : '#ef5350' 
                }}>
                  ${currentPrice.toFixed(2)}
                </span>
              )}
            </h2>
            
            {/* Timeframe selector */}
            <div style={{ display: 'flex', gap: '5px' }}>
              {['1m', '5m', '15m', '1h'].map(tf => (
                <button
                  key={tf}
                  onClick={() => {
                    setSelectedTimeframe(tf);
                    if (symbol) {
                      loadHistoricalData(symbol, tf);
                    }
                  }}
                  style={{
                    padding: '5px 10px',
                    backgroundColor: selectedTimeframe === tf ? '#2962ff' : '#2d2d2d',
                    color: '#d1d5db',
                    border: 'none',
                    borderRadius: '4px',
                    cursor: 'pointer',
                  }}
                >
                  {tf}
                </button>
              ))}
            </div>
          </div>
          
          <div style={{ display: 'flex', gap: '20px', alignItems: 'center' }}>
            <span>Trades: {tradeCount}</span>
            <span>Positions: {positions.size}</span>
            <span>Fills: {orderFills.length}</span>
            {isLoadingHistory && <span style={{ color: '#ffa726' }}>Loading history...</span>}
            <div>
              Status: <span style={{ color: connectionStatus === 'connected' ? '#26a69a' : '#ef5350' }}>
                {connectionStatus}
              </span>
            </div>
          </div>
        </div>
      </div>
      <div ref={chartContainerRef} style={{ width: '100%', height: 'calc(100% - 60px)' }} />
    </div>
  );
};

export default Chart;