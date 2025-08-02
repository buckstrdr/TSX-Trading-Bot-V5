/**
 * Global Configuration UI Server
 * Provides API endpoints for global system configuration only
 */

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs').promises;
const yaml = require('js-yaml');

const app = express();
const PORT = 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

// Serve shared UI assets
app.use('/shared', express.static(path.join(__dirname, '../shared')));

// Configuration paths
const CONFIG_PATH = path.join(__dirname, '../../../config');
const GLOBAL_CONFIG_PATH = path.join(CONFIG_PATH, 'global.yaml');

// Helper functions
async function loadYamlFile(filePath) {
    try {
        const content = await fs.readFile(filePath, 'utf8');
        return yaml.load(content);
    } catch (error) {
        console.error(`Error loading ${filePath}:`, error);
        return null;
    }
}

async function saveYamlFile(filePath, data) {
    try {
        const yamlContent = yaml.dump(data, {
            indent: 2,
            lineWidth: -1,
            noRefs: true
        });
        await fs.writeFile(filePath, yamlContent, 'utf8');
        return true;
    } catch (error) {
        console.error(`Error saving ${filePath}:`, error);
        return false;
    }
}

// Status check
app.get('/api/config/status', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Get global configuration
app.get('/api/config/global', async (req, res) => {
    const config = await loadYamlFile(GLOBAL_CONFIG_PATH);
    if (config) {
        res.json(config);
    } else {
        res.status(500).json({ error: 'Failed to load global configuration' });
    }
});

// Update global configuration
app.put('/api/config/global', async (req, res) => {
    const currentConfig = await loadYamlFile(GLOBAL_CONFIG_PATH) || {};
    
    // Merge with existing config to preserve fields we don't manage in UI
    const updatedConfig = {
        ...currentConfig,
        system: {
            ...currentConfig.system,
            ...req.body.system
        },
        api: {
            ...currentConfig.api,
            ...req.body.api
        },
        redis: {
            ...currentConfig.redis,
            ...req.body.redis
        },
        logging: {
            ...currentConfig.logging,
            ...req.body.logging
        },
        aggregator: {
            ...currentConfig.aggregator,
            ...req.body.aggregator
        }
    };
    
    const result = await saveYamlFile(GLOBAL_CONFIG_PATH, updatedConfig);
    if (result) {
        res.json({ success: true, message: 'Global configuration updated successfully' });
    } else {
        res.status(500).json({ error: 'Failed to save global configuration' });
    }
});

// Serve the UI
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Health check
app.get('/health', (req, res) => {
    res.json({ 
        status: 'ok',
        service: 'Global Configuration Server',
        port: PORT,
        timestamp: new Date().toISOString()
    });
});

// Start server
async function start() {
    try {
        app.listen(PORT, () => {
            console.log(`🔧 Global Configuration Server running on http://localhost:${PORT}`);
            console.log('📋 Available endpoints:');
            console.log(`   - Configuration UI: http://localhost:${PORT}`);
            console.log(`   - Get global config: GET /api/config/global`);
            console.log(`   - Update global config: PUT /api/config/global`);
            console.log(`   - Health check: GET /health`);
        });
    } catch (error) {
        console.error('Failed to start server:', error);
        process.exit(1);
    }
}

// Run if called directly
if (require.main === module) {
    start();
}

module.exports = app;