const fs = require('fs');
const path = require('path');

class FileLogger {
    constructor(serviceName, baseLogDir = 'logs') {
        this.serviceName = serviceName;
        // Make sure we use absolute path for logs directory
        if (!path.isAbsolute(baseLogDir)) {
            // Find the project root (TSX-Trading-Bot-V4)
            let currentDir = __dirname;
            while (currentDir !== path.dirname(currentDir)) {
                if (path.basename(currentDir) === 'TSX-Trading-Bot-V4') {
                    baseLogDir = path.join(currentDir, baseLogDir);
                    break;
                }
                currentDir = path.dirname(currentDir);
            }
        }
        this.baseLogDir = baseLogDir;
        this.logDir = path.join(baseLogDir, serviceName.toLowerCase().replace(/\s+/g, '-'));
        this.logFile = null;
        this.stream = null;
        
        this.ensureLogDirectory();
        this.createNewLogFile();
    }

    ensureLogDirectory() {
        // Create base logs directory if it doesn't exist
        if (!fs.existsSync(this.baseLogDir)) {
            fs.mkdirSync(this.baseLogDir, { recursive: true });
        }
        
        // Create service-specific directory
        if (!fs.existsSync(this.logDir)) {
            fs.mkdirSync(this.logDir, { recursive: true });
        }
    }

    createNewLogFile() {
        // Close existing stream if any
        if (this.stream) {
            this.stream.end();
        }

        // Generate filename with timestamp
        const now = new Date();
        const timestamp = now.getFullYear() + '-' +
            String(now.getMonth() + 1).padStart(2, '0') + '-' +
            String(now.getDate()).padStart(2, '0') + '_' +
            String(now.getHours()).padStart(2, '0') + '-' +
            String(now.getMinutes()).padStart(2, '0') + '-' +
            String(now.getSeconds()).padStart(2, '0');
        const filename = `${this.serviceName.toLowerCase().replace(/\s+/g, '-')}_${timestamp}.log`;
        this.logFile = path.join(this.logDir, filename);
        
        // Create write stream
        this.stream = fs.createWriteStream(this.logFile, { flags: 'a' });
        
        // Write header
        this.writeHeader();
    }

    writeHeader() {
        const header = `
================================================================================
${this.serviceName} Log File
Started: ${new Date().toISOString()}
================================================================================

`;
        this.stream.write(header);
    }

    log(level, message, data = null) {
        const timestamp = new Date().toISOString();
        const logEntry = {
            timestamp,
            level: level.toUpperCase(),
            message,
            ...(data && { data })
        };

        // Format for file
        let fileEntry = `[${timestamp}] [${level.toUpperCase()}] ${message}`;
        if (data) {
            fileEntry += `\n${JSON.stringify(data, null, 2)}`;
        }
        fileEntry += '\n';

        // Write to file
        if (this.stream && this.stream.writable) {
            this.stream.write(fileEntry);
        }

        // Also log to console with color coding
        this.consoleLog(level, message, data);
    }

    consoleLog(level, message, data) {
        // Check if running in silent mode
        const isSilent = process.env.SILENT_MODE === 'true' || 
                        process.argv.includes('--silent') || 
                        process.argv.includes('-s');
        
        if (isSilent) {
            return; // Don't output to console in silent mode
        }
        
        const now = new Date();
        const timestamp = String(now.getHours()).padStart(2, '0') + ':' +
            String(now.getMinutes()).padStart(2, '0') + ':' +
            String(now.getSeconds()).padStart(2, '0') + '.' +
            String(now.getMilliseconds()).padStart(3, '0');
        const colors = {
            ERROR: '\x1b[31m',    // Red
            WARN: '\x1b[33m',     // Yellow
            INFO: '\x1b[36m',     // Cyan
            DEBUG: '\x1b[90m',    // Gray
            SUCCESS: '\x1b[32m',  // Green
            SLTP: '\x1b[35m',     // Magenta (for SL/TP specific logs)
        };
        const reset = '\x1b[0m';
        const color = colors[level.toUpperCase()] || reset;

        let consoleMessage = `${color}[${timestamp}] [${this.serviceName}] ${message}${reset}`;
        
        if (data) {
            console.log(consoleMessage);
            console.log(JSON.stringify(data, null, 2));
        } else {
            console.log(consoleMessage);
        }
    }

    // Convenience methods
    error(message, data) { this.log('ERROR', message, data); }
    warn(message, data) { this.log('WARN', message, data); }
    info(message, data) { this.log('INFO', message, data); }
    debug(message, data) { this.log('DEBUG', message, data); }
    success(message, data) { this.log('SUCCESS', message, data); }
    sltp(message, data) { this.log('SLTP', message, data); }

    // Special method for SL/TP tracking
    logSLTP(action, details) {
        this.sltp(`[SL/TP] ${action}`, details);
    }

    // Close the logger
    close() {
        if (this.stream) {
            this.stream.end();
            this.stream = null;
        }
    }

    // Get current log file path
    getCurrentLogFile() {
        return this.logFile;
    }

    // List all log files for this service
    listLogFiles() {
        try {
            return fs.readdirSync(this.logDir)
                .filter(file => file.endsWith('.log'))
                .sort((a, b) => b.localeCompare(a)); // Most recent first
        } catch (error) {
            return [];
        }
    }
}

module.exports = FileLogger;