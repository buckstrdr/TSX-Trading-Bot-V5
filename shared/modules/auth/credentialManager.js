// shared-modules/auth/credentialManager.js
// Secure credential management with encryption and environment variable support
// Extracted from: C:\Users\salte\modular trading bot\enhanced-vwap-trading-bot\modules\security\credentialManager.js

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

class CredentialManager {
    constructor() {
        // Use a derived key from machine-specific info for encryption
        this.algorithm = 'aes-256-gcm';
        this.keyDerivationSalt = this.getMachineId();
        this.credentials = new Map();
        this.isInitialized = false;
    }

    // Get machine-specific identifier for key derivation
    getMachineId() {
        // Combine multiple machine-specific values
        const hostname = require('os').hostname();
        const platform = process.platform;
        const arch = process.arch;
        const username = process.env.USERNAME || process.env.USER || 'default';
        
        return crypto
            .createHash('sha256')
            .update(`${hostname}-${platform}-${arch}-${username}`)
            .digest();
    }

    // Derive encryption key from a master key
    deriveKey(masterKey) {
        return crypto.pbkdf2Sync(masterKey, this.keyDerivationSalt, 100000, 32, 'sha256');
    }

    // Encrypt sensitive data
    encrypt(text, masterKey) {
        const key = this.deriveKey(masterKey);
        const iv = crypto.randomBytes(16);
        const cipher = crypto.createCipheriv(this.algorithm, key, iv);
        
        let encrypted = cipher.update(text, 'utf8', 'base64');
        encrypted += cipher.final('base64');
        
        const authTag = cipher.getAuthTag();
        
        return {
            encrypted,
            iv: iv.toString('base64'),
            authTag: authTag.toString('base64')
        };
    }

    // Decrypt sensitive data
    decrypt(encryptedData, masterKey) {
        try {
            const key = this.deriveKey(masterKey);
            const decipher = crypto.createDecipheriv(
                this.algorithm,
                key,
                Buffer.from(encryptedData.iv, 'base64')
            );
            
            decipher.setAuthTag(Buffer.from(encryptedData.authTag, 'base64'));
            
            let decrypted = decipher.update(encryptedData.encrypted, 'base64', 'utf8');
            decrypted += decipher.final('utf8');
            
            return decrypted;
        } catch (error) {
            throw new Error('Failed to decrypt credentials. Invalid key or corrupted data.');
        }
    }

    // Initialize credential manager with environment variables
    async initialize() {
        try {
            // Load from environment variables first
            require('dotenv').config();
            
            console.log(`🔐 Initializing credentials for production`);
            
            // Use real/production credentials only
            const username = process.env.TOPSTEP_USERNAME_REAL || process.env.TOPSTEP_USERNAME || process.env.TRADING_USERNAME;
            const apiKey = process.env.TOPSTEP_API_KEY_REAL || process.env.TOPSTEP_API_KEY || process.env.TRADING_API_KEY;
            
            if (!username || !apiKey) {
                throw new Error(`Missing required credentials. Please check your .env file or environment variables.`);
            }
            
            this.storeCredential('username', username);
            this.storeCredential('apiKey', apiKey);
            this.storeCredential('profile', 'production');
            
            // Clear sensitive data from process.env after loading
            if (process.env.TRADING_API_KEY) delete process.env.TRADING_API_KEY;
            if (process.env.TOPSTEP_API_KEY) delete process.env.TOPSTEP_API_KEY;
            if (process.env.TOPSTEP_API_KEY_REAL) delete process.env.TOPSTEP_API_KEY_REAL;
            if (process.env.TOPSTEP_API_KEY_FAKE) delete process.env.TOPSTEP_API_KEY_FAKE;
            
            this.isInitialized = true;
            
            console.log('✅ Credential Manager initialized securely');
            console.log(`   Profile: production`);
            console.log(`   Username: ${this.getMaskedValue('username')}`);
            console.log(`   API Key: ${this.getMaskedValue('apiKey')}`);
            
            return true;
        } catch (error) {
            console.error('❌ Failed to initialize Credential Manager:', error.message);
            throw error;
        }
    }

    // Store credential in encrypted memory
    storeCredential(key, value) {
        if (!value) return;
        
        // Generate a random master key for this session
        const sessionKey = crypto.randomBytes(32);
        const encryptedData = this.encrypt(value, sessionKey);
        
        this.credentials.set(key, {
            data: encryptedData,
            key: sessionKey,
            storedAt: Date.now()
        });
    }

    // Retrieve decrypted credential
    getCredential(key) {
        const credential = this.credentials.get(key);
        if (!credential) return null;
        
        try {
            return this.decrypt(credential.data, credential.key);
        } catch (error) {
            console.error(`Failed to retrieve credential ${key}:`, error.message);
            return null;
        }
    }

    // Get masked version for logging
    getMaskedValue(key) {
        const value = this.getCredential(key);
        if (!value) return 'NOT SET';
        
        if (key === 'username') {
            // Show first and last character only
            if (value.length <= 2) return '*'.repeat(value.length);
            return value[0] + '*'.repeat(value.length - 2) + value[value.length - 1];
        } else if (key === 'apiKey') {
            // Show last 4 characters only
            if (value.length <= 4) return '*'.repeat(value.length);
            return '*'.repeat(value.length - 4) + value.slice(-4);
        }
        
        return '*'.repeat(8);
    }

    // Get credentials for authentication
    getAuthCredentials() {
        if (!this.isInitialized) {
            throw new Error('Credential Manager not initialized');
        }
        
        const username = this.getCredential('username');
        const apiKey = this.getCredential('apiKey');
        
        if (!username || !apiKey) {
            throw new Error('Missing required credentials');
        }
        
        return { username, apiKey };
    }

    // Get current API profile
    getApiProfile() {
        return this.getCredential('profile') || 'production';
    }

    // Clear all stored credentials
    clearCredentials() {
        // Overwrite memory before clearing
        for (const [key, credential] of this.credentials) {
            // Overwrite the session key
            if (credential.key) {
                credential.key.fill(0);
            }
        }
        
        this.credentials.clear();
        this.isInitialized = false;
        
        console.log('🔒 All credentials cleared from memory');
    }

    // Validate credential format
    validateCredentials() {
        const { username, apiKey } = this.getAuthCredentials();
        
        const errors = [];
        
        // Validate username
        if (!username || username.length < 3) {
            errors.push('Username must be at least 3 characters long');
        }
        
        // Real API key validation
        if (!apiKey || apiKey.length < 20) {
            errors.push('API key appears to be invalid');
        }
        
        return {
            valid: errors.length === 0,
            errors
        };
    }
    
    // Reload credentials (useful for profile switching)
    async reload() {
        console.log('🔄 Reloading credentials...');
        this.clearCredentials();
        await this.initialize();
    }
}

// Export singleton instance
module.exports = new CredentialManager();