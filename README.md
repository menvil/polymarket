# Polymarket Market Making Bot v3

Production-ready market making bot for Polymarket with Domain-Driven Design architecture.

## 🏗️ Architecture

This project follows **Domain-Driven Design (DDD)** principles with clean separation of concerns:

- **Domain Layer**: Pure business logic (entities, value objects, domain services)
- **Application Layer**: Use cases, orchestrators, DTOs
- **Infrastructure Layer**: External dependencies (exchange adapters, persistence, logging)
- **Bootstrap Layer**: Application initialization and dependency injection

## 📦 Project Structure

```
polymarket-mm-bot/
├── src/
│   ├── domain/              # Business logic
│   ├── application/         # Use cases
│   ├── infrastructure/      # External systems
│   ├── shared/              # Common utilities
│   └── bootstrap/           # App initialization
├── tests/                   # Tests (unit, integration, e2e)
├── configs/                 # TypeScript & Jest configs
└── scripts/                 # Build & deployment scripts
```

## 🚀 Quick Start

### Prerequisites

- Node.js >= 20.0.0
- npm >= 10.0.0

### Installation

```bash
# Install dependencies
npm install

# Copy environment file
cp .env.example .env

# Configure your credentials in .env
# PRIVATE_KEY=0x...
# FUNDER_ADDRESS=0x...
```

### Development

```bash
# Run in development mode with hot reload
npm run dev

# Run with inspector for debugging
npm run dev:inspect

# Type checking
npm run type-check

# Linting
npm run lint
npm run lint:fix

# Formatting
npm run format
```

### Testing

```bash
# Run all tests
npm test

# Run with watch mode
npm run test:watch

# Run specific test suites
npm run test:unit
npm run test:integration
npm run test:e2e

# Generate coverage report
npm run test:coverage
```

### Production

```bash
# Build the project
npm run build

# Start in production mode
npm start
```

## ⚙️ Configuration

### Environment Variables

- `NODE_ENV`: Environment (development/test/production)
- `PRIVATE_KEY`: Your wallet private key (required for live trading)
- `FUNDER_ADDRESS`: Proxy wallet address (optional)
- `POLYGON_RPC_URL`: Polygon RPC endpoint
- `LIVE_SAFE_MODE`: Enable safe mode limits (1 = enabled)
- `LIVE_CLEAN_START`: Clean start without existing positions (1 = enabled)
- `LOG_LEVEL`: Logging level (DEBUG/INFO/WARN/ERROR)

### Trading Parameters

All trading parameters are configured in `src/infrastructure/config/TradingConfig.ts`:

- Market filters and selection
- Fair value calculation weights
- Risk management limits
- Quote generation settings
- Order management parameters

## 🧪 Testing

The project includes comprehensive test coverage:

- **Unit Tests**: Domain logic and business rules
- **Integration Tests**: Service interactions
- **E2E Tests**: Full trading scenarios
- **Performance Tests**: Benchmarking critical paths

## 📚 Documentation

- [Architecture Overview](docs/architecture/overview.md)
- [Development Guide](docs/guides/development.md)
- [API Reference](docs/api/)

## 🛡️ Safety Features

- **Simulation Mode**: Test strategies without real trades
- **Safe Mode**: Strict position and order limits
- **Risk Management**: Multiple layers of safety checks
- **Kill Switches**: Automatic shutdown on errors

## 📝 License

MIT

## 🤝 Contributing

This is a private project. See CONTRIBUTING.md for guidelines.
