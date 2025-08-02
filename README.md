# TSX Trading Bot V5

Clean architecture version of the TSX Trading Bot with optimized directory structure and improved path management.

## Overview

TSX Trading Bot V5 is a comprehensive automated trading system designed for the TopStepX platform. This version features:
- Clean, organized directory structure
- Simplified path management
- All active components with no legacy/backup files
- Microservices architecture with Redis pub/sub messaging

## Architecture

### Core Components

1. **Connection Manager** (Port 7500) - Gateway to TopStepX API
2. **Trading Aggregator** (Port 7600) - Central orchestration service
3. **Redis Server** (Port 6379) - Message broker for inter-service communication
4. **Control Panel** (Port 8080) - Web-based service management dashboard
5. **Manual Trading** (Port 3003) - Web interface for manual trading
6. **Trading Bots** (Ports 3004-3009) - Automated trading bot instances

### Directory Structure

```
TSX-Trading-Bot-V5/
├── config/                 # Configuration files
│   ├── bots/              # Bot-specific configs
│   ├── global.yaml        # Global configuration
│   └── instruments.yaml   # Trading instruments
├── connection-manager/     # Connection Manager service
│   ├── core/              # Core connection logic
│   ├── services/          # Service modules
│   └── handlers/          # Request handlers
├── manual-trading/         # Manual trading interface
├── shared/                 # Shared utilities and modules
│   ├── utils/             # Common utilities
│   └── modules/           # Shared modules
├── src/                    # Source code
│   ├── core/              # Core business logic
│   │   ├── aggregator/    # Trading aggregator
│   │   └── trading/       # Trading bot framework
│   ├── infrastructure/    # Infrastructure code
│   ├── strategies/        # Trading strategies
│   ├── indicators/        # Technical indicators
│   └── ui/                # User interfaces
├── scripts/               # Operational scripts
│   ├── services/         # Service management
│   ├── bots/            # Bot management
│   └── control/         # System control
├── logs/                 # Application logs
├── docs/                 # Documentation
└── tests/                # Test files
```

## Getting Started

### Prerequisites

- Node.js >= 18.0.0
- Redis Server
- Windows OS (for batch files)
- TopStepX API credentials

### Installation

1. Clone the repository:
```bash
git clone https://github.com/[your-username]/TSX-Trading-Bot-V5.git
cd TSX-Trading-Bot-V5
```

2. Install dependencies:
```bash
npm install
```

3. Configure environment:
```bash
cp .env.template .env
# Edit .env with your credentials
```

4. Start services:
```bash
# Start all services
.\LAUNCH-CONTROL-PANEL.bat

# Or start individually
npm run connection-manager
npm run aggregator
npm run manual-trading
```

## Configuration

- Global settings: `config/global.yaml`
- Bot configurations: `config/bots/BOT_[1-6].yaml`
- Environment variables: `.env`

## Key Features

- **Automated Trading**: 6 configurable bot instances
- **Manual Trading**: Web-based interface with SL/TP support
- **Risk Management**: Global risk limits enforced by aggregator
- **Real-time Monitoring**: Dashboard at port 7700
- **Multiple Strategies**: EMA and ORB Rubber Band strategies

## Development

### Running Tests
```bash
npm test                    # Run all tests
npm run test:unit          # Unit tests only
npm run test:integration   # Integration tests
npm run test:e2e          # End-to-end tests
```

### Code Quality
```bash
npm run lint              # Check code style
npm run lint:fix         # Auto-fix style issues
```

## Service Communication

Services communicate via Redis pub/sub channels:
- `market:data` - Market price updates
- `order:management` - Order requests/responses
- `position:updates` - Position changes
- `system:alerts` - System alerts
- `config:updates` - Configuration changes
- `health:status` - Health check updates

## License

PROPRIETARY - All rights reserved

## Support

For issues and questions, please create an issue in the repository.