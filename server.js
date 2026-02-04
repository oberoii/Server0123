const fs = require('fs');
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const compression = require('compression');
const morgan = require('morgan');
require('dotenv').config();

// Load fca-mafiya with fallback
let wiegine;
try {
    wiegine = require('fca-mafiya');
    console.log('✅ fca-mafiya loaded successfully');
} catch (error) {
    console.warn('⚠️ fca-mafiya not found, using fallback');
    wiegine = {
        login: (cookie, options, callback) => {
            console.log('📝 Mock login with cookie');
            setTimeout(() => {
                callback(null, {
                    sendMessage: (msg, thread, cb) => {
                        console.log(`📤 Mock sending: ${msg.substring(0, 50)}...`);
                        setTimeout(() => cb(null), 1000);
                    },
                    getThreadInfo: (thread, cb) => cb(null, { name: 'Test Group' }),
                    getUserInfo: (id, cb) => cb(null, { [id]: { name: 'Test User' } }),
                    getCurrentUserID: (cb) => cb(null, '100000000000000')
                });
            }, 500);
        }
    };
}

const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

// Initialize Express app
const app = express();

// Security middleware
app.use(helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false
}));
app.use(cors());
app.use(compression());
app.use(morgan('tiny'));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Configuration
const PORT = process.env.PORT || 21615;
const MAX_TASKS = parseInt(process.env.MAX_TASKS) || 10;
const NODE_ENV = process.env.NODE_ENV || 'development';

// Store active tasks
const TASKS_FILE = 'active_tasks.json';
const COOKIES_DIR = 'cookies';
const LOGS_DIR = 'logs';
const BACKUPS_DIR = 'backups';

// Ensure directories exist
[COOKIES_DIR, LOGS_DIR, BACKUPS_DIR].forEach(dir => {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
        console.log(`📁 Created directory: ${dir}`);
    }
});

// Load persistent tasks
function loadTasks() {
    try {
        if (fs.existsSync(TASKS_FILE)) {
            const data = fs.readFileSync(TASKS_FILE, 'utf8');
            const tasksData = JSON.parse(data);
            const tasks = new Map();

            for (let [taskId, taskData] of Object.entries(tasksData)) {
                const task = new Task(taskId, taskData.userData);
                task.config = taskData.config;
                task.messageData = taskData.messageData;
                task.stats = taskData.stats;
                task.logs = taskData.logs || [];
                task.config.running = true;
                tasks.set(taskId, task);

                console.log(`✅ Reloaded persistent task: ${taskId}`);

                setTimeout(() => {
                    if (task.config.running) {
                        task.start();
                    }
                }, 5000);
            }

            return tasks;
        }
    } catch (error) {
        console.error('❌ Error loading tasks:', error.message);
    }
    return new Map();
}

// Save tasks persistently
function saveTasks() {
    try {
        const tasksData = {};
        for (let [taskId, task] of activeTasks.entries()) {
            if (task.config.running) {
                tasksData[taskId] = {
                    userData: task.userData,
                    config: { ...task.config, api: null },
                    messageData: task.messageData,
                    stats: task.stats,
                    logs: task.logs.slice(0, 50)
                };
            }
        }
        fs.writeFileSync(TASKS_FILE, JSON.stringify(tasksData, null, 2));
        console.log(`💾 Saved ${Object.keys(tasksData).length} tasks`);
    } catch (error) {
        console.error('❌ Error saving tasks:', error.message);
    }
}

// Auto-save every 30 seconds
setInterval(saveTasks, 30000);

let activeTasks = loadTasks();

// Platform detection
function getPlatformInfo() {
    return {
        isReplit: !!process.env.REPL_ID,
        isGlitch: !!process.env.PROJECT_REMIX_CHAIN,
        isHeroku: !!process.env.HEROKU,
        isRailway: !!process.env.RAILWAY_ENVIRONMENT,
        isVPS: !process.env.REPL_ID && !process.env.PROJECT_REMIX_CHAIN
    };
}

class Task {
    constructor(taskId, userData) {
        this.taskId = taskId;
        this.userData = userData;
        this.config = {
            delay: userData.delay || 5,
            running: false,
            api: null,
            lastActivity: Date.now(),
            restartCount: 0,
            maxRestarts: 50,
            cookieMode: userData.cookieMode || 'paste'
        };
        this.messageData = {
            threadID: userData.threadID,
            messages: [],
            currentIndex: 0,
            loopCount: 0
        };
        this.stats = {
            sent: 0,
            failed: 0,
            activeCookies: 0,
            loops: 0,
            restarts: 0,
            lastSuccess: null,
            startTime: Date.now()
        };
        this.logs = [];
        this.retryCount = 0;
        this.maxRetries = userData.maxRetries || 30;
        this.initializeMessages(userData.messageContent, userData.hatersName, userData.lastHereName);
    }

    initializeMessages(messageContent, hatersName, lastHereName) {
        if (!messageContent || !hatersName || !lastHereName) {
            this.addLog("⚠️ Missing message data", 'warning');
            return;
        }

        this.messageData.messages = messageContent
            .split('\n')
            .map(line => line.replace(/\r/g, '').trim())
            .filter(line => line.length > 0)
            .map(message => `${hatersName} ${message} ${lastHereName}`);

        this.addLog(`✅ Loaded ${this.messageData.messages.length} messages`);
    }

    addLog(message, messageType = 'info') {
        const logEntry = {
            time: new Date().toLocaleTimeString('en-IN'),
            message: message,
            type: messageType
        };
        this.logs.unshift(logEntry);
        
        // Save log to file
        this.saveLogToFile(logEntry);
        
        if (this.logs.length > 200) {
            this.logs = this.logs.slice(0, 200);
        }

        this.config.lastActivity = Date.now();
        broadcastToTask(this.taskId, {
            type: 'log',
            message: message,
            messageType: messageType
        });
    }

    saveLogToFile(logEntry) {
        try {
            const logFile = path.join(LOGS_DIR, `task_${this.taskId}.log`);
            const logLine = `[${logEntry.time}] [${logEntry.type.toUpperCase()}] ${logEntry.message}\n`;
            fs.appendFileSync(logFile, logLine);
        } catch (err) {
            console.error('Error saving log:', err.message);
        }
    }

    healthCheck() {
        return Date.now() - this.config.lastActivity < 300000;
    }

    async start() {
        if (this.config.running) {
            this.addLog('⚠️ Task already running', 'warning');
            return false;
        }

        // Validate cookie
        if (!this.validateCookie(this.userData.cookieContent)) {
            this.addLog('❌ Invalid cookie format', 'error');
            return false;
        }

        this.config.running = true;
        this.retryCount = 0;
        this.stats.startTime = Date.now();

        // Save cookie
        try {
            const cookiePath = path.join(COOKIES_DIR, `cookie_${this.taskId}.txt`);
            fs.writeFileSync(cookiePath, this.userData.cookieContent);
            this.addLog('✅ Cookie saved', 'success');
        } catch (err) {
            this.addLog(`❌ Cookie save failed: ${err.message}`, 'error');
            this.config.running = false;
            return false;
        }

        if (this.messageData.messages.length === 0) {
            this.addLog('❌ No messages loaded', 'error');
            this.config.running = false;
            return false;
        }

        this.addLog(`🚀 Starting with ${this.messageData.messages.length} messages`);
        return this.initializeBot();
    }

    validateCookie(cookie) {
        if (!cookie) return false;
        // Basic Facebook cookie validation
        const hasCUser = cookie.includes('c_user=');
        const hasXs = cookie.includes('xs=');
        return hasCUser && hasXs;
    }

    initializeBot() {
        return new Promise((resolve) => {
            const loginOptions = {
                logLevel: "silent",
                forceLogin: true,
                selfListen: false,
                userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
            };

            this.addLog('🔑 Logging in...', 'info');
            
            wiegine.login(this.userData.cookieContent, loginOptions, (err, api) => {
                if (err || !api) {
                    const errorMsg = err ? err.message : 'Unknown error';
                    this.addLog(`❌ Login failed: ${errorMsg}`, 'error');

                    if (this.retryCount < this.maxRetries) {
                        this.retryCount++;
                        this.addLog(`🔄 Retry ${this.retryCount}/${this.maxRetries} in 30s`, 'info');
                        
                        setTimeout(() => {
                            this.initializeBot();
                        }, 30000);
                    } else {
                        this.addLog('⏸️ Max retries reached', 'error');
                        this.config.running = false;
                    }
                    
                    resolve(false);
                    return;
                }

                this.config.api = api;
                this.stats.activeCookies = 1;
                this.retryCount = 0;
                this.addLog('✅ Login successful', 'success');

                // Get user info
                this.getUserInfo(api);
                
                // Start sending
                this.sendNextMessage(api);
                
                resolve(true);
            });
        });
    }

    getUserInfo(api) {
        try {
            api.getCurrentUserID((err, id) => {
                if (!err && id) {
                    api.getUserInfo(id, (err, info) => {
                        if (!err && info && info[id]) {
                            this.addLog(`👤 User: ${info[id].name || 'Unknown'}`, 'info');
                        }
                    });
                }
            });
        } catch (e) {}
    }

    sendNextMessage(api) {
        if (!this.config.running || !api) {
            return;
        }

        // Loop handling
        if (this.messageData.currentIndex >= this.messageData.messages.length) {
            this.messageData.loopCount++;
            this.stats.loops = this.messageData.loopCount;
            this.addLog(`🔄 Loop ${this.messageData.loopCount} completed`, 'info');
            this.messageData.currentIndex = 0;
        }

        const message = this.messageData.messages[this.messageData.currentIndex];
        const currentIndex = this.messageData.currentIndex;
        const totalMessages = this.messageData.messages.length;

        this.sendMessageWithRetry(api, message, currentIndex, totalMessages);
    }

    sendMessageWithRetry(api, message, currentIndex, totalMessages, retryAttempt = 0) {
        if (!this.config.running) return;

        const maxSendRetries = 8;

        try {
            api.sendMessage(message, this.messageData.threadID, (err) => {
                const timestamp = new Date().toLocaleTimeString('en-IN');

                if (err) {
                    this.stats.failed++;

                    // 15-digit chat ID check
                    const threadID = this.messageData.threadID;
                    const is15DigitChat = /^\d{15}$/.test(threadID);

                    if (is15DigitChat) {
                        this.addLog("🔧 15-digit chat detected", 'warning');
                        this.sendTo15DigitChat(api, message, threadID, currentIndex, totalMessages, retryAttempt);
                        return;
                    }

                    if (retryAttempt < maxSendRetries) {
                        this.addLog(`🔄 Retry ${retryAttempt + 1}/${maxSendRetries}`, 'info');
                        
                        setTimeout(() => {
                            this.sendMessageWithRetry(api, message, currentIndex, totalMessages, retryAttempt + 1);
                        }, 3000);
                    } else {
                        this.addLog(`❌ Failed after ${maxSendRetries} retries`, 'error');
                        this.messageData.currentIndex++;
                        this.scheduleNextMessage(api);
                    }
                } else {
                    this.stats.sent++;
                    this.stats.lastSuccess = Date.now();
                    this.retryCount = 0;
                    this.addLog(`✅ Sent ${currentIndex + 1}/${totalMessages}`, 'success');
                    
                    this.messageData.currentIndex++;
                    this.scheduleNextMessage(api);
                }
            });
        } catch (sendError) {
            this.addLog("🚨 Send error - restarting", 'error');
            this.restart();
        }
    }

    sendTo15DigitChat(api, message, threadID, currentIndex, totalMessages, retryAttempt = 0) {
        const max15DigitRetries = 5;

        try {
            api.sendMessage({
                body: message
            }, threadID, (err) => {
                if (err) {
                    const numericThreadID = parseInt(threadID);
                    api.sendMessage(message, numericThreadID, (err2) => {
                        if (err2) {
                            if (retryAttempt < max15DigitRetries) {
                                this.addLog(`🔄 15-digit retry ${retryAttempt + 1}/${max15DigitRetries}`, 'info');
                                setTimeout(() => {
                                    this.sendTo15DigitChat(api, message, threadID, currentIndex, totalMessages, retryAttempt + 1);
                                }, 3000);
                            } else {
                                this.addLog("❌ 15-digit chat failed", 'error');
                                this.messageData.currentIndex++;
                                this.scheduleNextMessage(api);
                            }
                        } else {
                            this.stats.sent++;
                            this.stats.lastSuccess = Date.now();
                            this.addLog(`✅ Sent to 15-digit chat`, 'success');
                            this.messageData.currentIndex++;
                            this.scheduleNextMessage(api);
                        }
                    });
                } else {
                    this.stats.sent++;
                    this.stats.lastSuccess = Date.now();
                    this.addLog(`✅ Sent to 15-digit chat`, 'success');
                    this.messageData.currentIndex++;
                    this.scheduleNextMessage(api);
                }
            });
        } catch (error) {
            if (retryAttempt < max15DigitRetries) {
                setTimeout(() => {
                    this.sendTo15DigitChat(api, message, threadID, currentIndex, totalMessages, retryAttempt + 1);
                }, 3000);
            } else {
                this.addLog("❌ 15-digit chat error", 'error');
                this.messageData.currentIndex++;
                this.scheduleNextMessage(api);
            }
        }
    }

    scheduleNextMessage(api) {
        if (!this.config.running) return;

        setTimeout(() => {
            try {
                this.sendNextMessage(api);
            } catch (e) {
                this.addLog("🚨 Scheduler error", 'error');
                this.restart();
            }
        }, this.config.delay * 1000);
    }

    pause() {
        if (this.config.running) {
            this.config.running = false;
            this.addLog('⏸️ Task paused', 'info');
            return true;
        }
        return false;
    }

    resume() {
        if (!this.config.running && this.config.api) {
            this.config.running = true;
            this.addLog('▶️ Task resumed', 'success');
            this.sendNextMessage(this.config.api);
            return true;
        }
        return false;
    }

    restart() {
        this.addLog('🔄 Restarting task...', 'info');
        this.stats.restarts++;
        this.config.restartCount++;

        if (this.config.api) {
            this.config.api = null;
        }

        this.stats.activeCookies = 0;

        setTimeout(() => {
            if (this.config.running && this.config.restartCount <= this.config.maxRestarts) {
                this.initializeBot();
            } else if (this.config.restartCount > this.config.maxRestarts) {
                this.addLog('🚨 Max restarts reached', 'error');
                this.config.running = false;
            }
        }, 10000);
    }

    stop() {
        console.log(`🛑 Stopping task: ${this.taskId}`);
        this.config.running = false;
        this.stats.activeCookies = 0;
        
        this.addLog('🛑 Task stopped', 'info');
        
        try {
            const cookiePath = path.join(COOKIES_DIR, `cookie_${this.taskId}.txt`);
            if (fs.existsSync(cookiePath)) {
                fs.unlinkSync(cookiePath);
            }
        } catch (e) {}
        
        if (!this.config.running) {
            activeTasks.delete(this.taskId);
        }
        
        saveTasks();
        return true;
    }

    getDetails() {
        const uptime = Date.now() - this.stats.startTime;
        const hours = Math.floor(uptime / 3600000);
        const minutes = Math.floor((uptime % 3600000) / 60000);
        
        return {
            taskId: this.taskId,
            sent: this.stats.sent,
            failed: this.stats.failed,
            activeCookies: this.stats.activeCookies,
            loops: this.stats.loops,
            restarts: this.stats.restarts,
            logs: this.logs.slice(0, 20),
            running: this.config.running,
            uptime: `${hours}h ${minutes}m`,
            threadID: this.messageData.threadID,
            currentIndex: this.messageData.currentIndex,
            totalMessages: this.messageData.messages.length,
            delay: this.config.delay
        };
    }
}

// WebSocket functions
function broadcastToTask(taskId, message) {
    if (!wss) return;

    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN && client.taskId === taskId) {
            try {
                client.send(JSON.stringify(message));
            } catch (e) {
                console.error('Broadcast error:', e.message);
            }
        }
    });
}

function broadcastToAll(message) {
    if (!wss) return;

    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            try {
                client.send(JSON.stringify(message));
            } catch (e) {}
        }
    });
}

// Setup auto-restart
function setupAutoRestart() {
    setInterval(() => {
        for (let [taskId, task] of activeTasks.entries()) {
            if (task.config.running && !task.healthCheck()) {
                console.log(`🔄 Auto-restarting stuck task: ${taskId}`);
                task.restart();
            }
        }
    }, 60000);
}

// ======================== HTML INTERFACE ========================

const htmlControlPanel = `
<!DOCTYPE html>
<html>
<head>
    <title>SK COOKIE SERVER - ADVANCED</title>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }

        :root {
            --primary: #ff3366;
            --secondary: #00ccff;
            --success: #00ff88;
            --danger: #ff4444;
            --warning: #ffaa00;
            --dark: #0a0a1a;
            --light: #ffffff;
            --gray: #888888;
        }

        body {
            background: linear-gradient(135deg, var(--dark) 0%, #1a1a2e 100%);
            color: var(--light);
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            min-height: 100vh;
            padding: 20px;
        }

        .container {
            max-width: 1400px;
            margin: 0 auto;
            display: grid;
            grid-template-columns: 1fr 2fr;
            gap: 20px;
        }

        .header {
            background: linear-gradient(90deg, var(--primary), var(--secondary));
            padding: 25px;
            border-radius: 15px;
            text-align: center;
            margin-bottom: 30px;
            grid-column: 1 / -1;
            box-shadow: 0 10px 30px rgba(0, 0, 0, 0.3);
            animation: glow 2s infinite alternate;
        }

        @keyframes glow {
            from { box-shadow: 0 10px 30px rgba(255, 51, 102, 0.3); }
            to { box-shadow: 0 10px 40px rgba(0, 204, 255, 0.4); }
        }

        .header h1 {
            font-size: 2.5em;
            margin-bottom: 10px;
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 15px;
        }

        .status-badge {
            display: inline-block;
            padding: 8px 20px;
            background: rgba(255, 255, 255, 0.2);
            border-radius: 25px;
            font-size: 0.9em;
            margin: 5px;
            backdrop-filter: blur(10px);
        }

        .card {
            background: rgba(255, 255, 255, 0.05);
            backdrop-filter: blur(10px);
            border: 1px solid rgba(255, 255, 255, 0.1);
            border-radius: 15px;
            padding: 25px;
            margin-bottom: 20px;
            transition: all 0.3s ease;
        }

        .card:hover {
            transform: translateY(-5px);
            border-color: var(--primary);
        }

        .card h2 {
            color: var(--secondary);
            margin-bottom: 20px;
            padding-bottom: 10px;
            border-bottom: 2px solid rgba(0, 204, 255, 0.3);
            display: flex;
            align-items: center;
            gap: 10px;
        }

        .form-group {
            margin-bottom: 20px;
        }

        label {
            display: block;
            margin-bottom: 8px;
            color: #aaccff;
            font-weight: 500;
        }

        input, textarea, select {
            width: 100%;
            padding: 12px 15px;
            background: rgba(255, 255, 255, 0.07);
            border: 1px solid rgba(255, 255, 255, 0.1);
            border-radius: 8px;
            color: var(--light);
            font-size: 14px;
            transition: all 0.3s;
        }

        input:focus, textarea:focus, select:focus {
            outline: none;
            border-color: var(--primary);
            box-shadow: 0 0 0 3px rgba(255, 51, 102, 0.2);
        }

        textarea {
            min-height: 120px;
            resize: vertical;
            font-family: 'Consolas', monospace;
        }

        .btn {
            padding: 12px 25px;
            border: none;
            border-radius: 8px;
            font-weight: 600;
            cursor: pointer;
            transition: all 0.3s;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            gap: 10px;
            font-size: 14px;
        }

        .btn-primary {
            background: linear-gradient(135deg, var(--primary), #ff6699);
            color: white;
        }

        .btn-primary:hover {
            background: linear-gradient(135deg, #ff6699, var(--primary));
            transform: translateY(-2px);
            box-shadow: 0 5px 15px rgba(255, 51, 102, 0.4);
        }

        .btn-danger {
            background: linear-gradient(135deg, var(--danger), #ff6666);
            color: white;
        }

        .btn-success {
            background: linear-gradient(135deg, var(--success), #00ffaa);
            color: white;
        }

        .btn-warning {
            background: linear-gradient(135deg, var(--warning), #ffcc00);
            color: black;
        }

        .mode-selector {
            display: flex;
            gap: 10px;
            margin-bottom: 20px;
        }

        .mode-btn {
            flex: 1;
            padding: 15px;
            text-align: center;
            background: rgba(255, 255, 255, 0.05);
            border: 2px solid transparent;
            border-radius: 10px;
            cursor: pointer;
            transition: all 0.3s;
        }

        .mode-btn.active {
            border-color: var(--primary);
            background: rgba(255, 51, 102, 0.1);
        }

        .mode-btn:hover {
            background: rgba(255, 255, 255, 0.1);
        }

        .file-input-container {
            position: relative;
            overflow: hidden;
            margin-bottom: 15px;
        }

        .file-input-container input[type="file"] {
            position: absolute;
            left: 0;
            top: 0;
            opacity: 0;
            width: 100%;
            height: 100%;
            cursor: pointer;
        }

        .file-input-label {
            display: block;
            padding: 25px;
            background: rgba(255, 255, 255, 0.05);
            border: 2px dashed rgba(255, 255, 255, 0.1);
            border-radius: 10px;
            text-align: center;
            cursor: pointer;
            transition: all 0.3s;
        }

        .file-input-label:hover {
            border-color: var(--primary);
            background: rgba(255, 51, 102, 0.1);
        }

        .file-input-label i {
            font-size: 2em;
            margin-bottom: 10px;
            display: block;
            color: var(--primary);
        }

        .task-list {
            max-height: 500px;
            overflow-y: auto;
        }

        .task-item {
            background: rgba(255, 255, 255, 0.03);
            border: 1px solid rgba(255, 255, 255, 0.05);
            border-radius: 10px;
            padding: 15px;
            margin-bottom: 10px;
            transition: all 0.3s;
        }

        .task-item:hover {
            background: rgba(255, 255, 255, 0.07);
            border-color: var(--primary);
        }

        .task-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 10px;
        }

        .task-id {
            font-family: monospace;
            color: var(--success);
            font-size: 0.9em;
            background: rgba(0, 255, 136, 0.1);
            padding: 3px 10px;
            border-radius: 5px;
        }

        .task-status {
            padding: 5px 15px;
            border-radius: 20px;
            font-size: 0.8em;
            font-weight: bold;
        }

        .status-running {
            background: rgba(0, 255, 136, 0.2);
            color: var(--success);
        }

        .status-stopped {
            background: rgba(255, 68, 68, 0.2);
            color: var(--danger);
        }

        .task-stats {
            display: grid;
            grid-template-columns: repeat(3, 1fr);
            gap: 10px;
            margin-top: 15px;
        }

        .stat-item {
            text-align: center;
            padding: 10px;
            background: rgba(255, 255, 255, 0.05);
            border-radius: 8px;
        }

        .stat-value {
            font-size: 1.2em;
            font-weight: bold;
            color: var(--success);
        }

        .stat-label {
            font-size: 0.8em;
            color: var(--gray);
            margin-top: 5px;
        }

        .log-container {
            background: rgba(0, 0, 0, 0.3);
            border-radius: 10px;
            padding: 15px;
            height: 400px;
            overflow-y: auto;
            font-family: 'Courier New', monospace;
            font-size: 12px;
        }

        .log-entry {
            padding: 8px 12px;
            margin-bottom: 5px;
            border-left: 4px solid transparent;
            border-radius: 4px;
            background: rgba(255, 255, 255, 0.03);
        }

        .log-info { border-left-color: var(--secondary); }
        .log-success { border-left-color: var(--success); }
        .log-warning { border-left-color: var(--warning); }
        .log-error { border-left-color: var(--danger); }

        .log-time {
            color: var(--gray);
            margin-right: 10px;
            font-size: 0.9em;
        }

        .control-buttons {
            display: flex;
            gap: 10px;
            margin-top: 20px;
        }

        .control-buttons .btn {
            flex: 1;
        }

        .alert {
            padding: 15px;
            border-radius: 10px;
            margin: 15px 0;
            display: none;
            animation: slideIn 0.3s ease;
        }

        @keyframes slideIn {
            from { transform: translateY(-20px); opacity: 0; }
            to { transform: translateY(0); opacity: 1; }
        }

        .alert-success {
            background: rgba(0, 255, 136, 0.1);
            border: 1px solid var(--success);
            color: var(--success);
        }

        .alert-error {
            background: rgba(255, 68, 68, 0.1);
            border: 1px solid var(--danger);
            color: var(--danger);
        }

        /* Scrollbar Styling */
        ::-webkit-scrollbar {
            width: 8px;
        }

        ::-webkit-scrollbar-track {
            background: rgba(255, 255, 255, 0.05);
            border-radius: 4px;
        }

        ::-webkit-scrollbar-thumb {
            background: var(--primary);
            border-radius: 4px;
        }

        ::-webkit-scrollbar-thumb:hover {
            background: var(--secondary);
        }

        @media (max-width: 1024px) {
            .container {
                grid-template-columns: 1fr;
            }
        }

        @media (max-width: 768px) {
            .header h1 {
                font-size: 1.8em;
            }
            
            .control-buttons {
                flex-direction: column;
            }
            
            .mode-selector {
                flex-direction: column;
            }
            
            .task-stats {
                grid-template-columns: repeat(2, 1fr);
            }
        }
    </style>
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css">
</head>
<body>
    <div class="container">
        <!-- Header -->
        <div class="header">
            <h1>
                <i class="fas fa-fire"></i>
                SK COOKIE SERVER
                <i class="fas fa-bolt"></i>
            </h1>
            <p>Professional Cookie Messenger Bot with Auto-Recovery System</p>
            <div>
                <span class="status-badge"><i class="fas fa-shield-alt"></i> Auto-Recovery: ACTIVE</span>
                <span class="status-badge"><i class="fas fa-comments"></i> 15-digit Chat Support</span>
                <span class="status-badge"><i class="fas fa-database"></i> Persistent Tasks</span>
                <span class="status-badge"><i class="fas fa-bolt"></i> High Performance</span>
            </div>
        </div>

        <!-- Left Column: Task Control -->
        <div>
            <!-- Cookie Input Section -->
            <div class="card">
                <h2><i class="fas fa-cookie-bite"></i> Cookie Input Method</h2>
                
                <div class="mode-selector">
                    <div class="mode-btn active" onclick="setCookieMode('paste')">
                        <i class="fas fa-paste"></i>
                        <div>Paste Cookie</div>
                    </div>
                    <div class="mode-btn" onclick="setCookieMode('upload')">
                        <i class="fas fa-upload"></i>
                        <div>Upload File</div>
                    </div>
                </div>

                <div id="cookiePasteSection" class="form-group">
                    <label><i class="fas fa-key"></i> Paste Cookie Content</label>
                    <textarea id="cookieContent" placeholder="Paste your Facebook cookie here...
Format should include: c_user=...; xs=..." rows="8"></textarea>
                </div>

                <div id="cookieFileSection" class="form-group" style="display: none;">
                    <label><i class="fas fa-file-upload"></i> Upload Cookie File</label>
                    <div class="file-input-container">
                        <input type="file" id="cookieFile" accept=".txt,.json">
                        <div class="file-input-label">
                            <i class="fas fa-cloud-upload-alt"></i>
                            <div>Click to upload cookie file</div>
                            <small>.txt files containing cookies</small>
                        </div>
                    </div>
                </div>

                <div class="form-group">
                    <label><i class="fas fa-comment-dots"></i> Message File</label>
                    <div class="file-input-container">
                        <input type="file" id="messageFile" accept=".txt">
                        <div class="file-input-label">
                            <i class="fas fa-file-alt"></i>
                            <div>Click to upload message file</div>
                            <small>One message per line</small>
                        </div>
                    </div>
                </div>
            </div>

            <!-- Configuration Section -->
            <div class="card">
                <h2><i class="fas fa-cogs"></i> Bot Configuration</h2>
                
                <div class="form-group">
                    <label><i class="fas fa-user-tag"></i> Hater's Name</label>
                    <input type="text" id="hatersName" placeholder="Enter hater's name">
                </div>

                <div class="form-group">
                    <label><i class="fas fa-user-clock"></i> Last Here Name</label>
                    <input type="text" id="lastHereName" placeholder="Enter last here name">
                </div>

                <div class="form-group">
                    <label><i class="fas fa-hashtag"></i> Thread/Group ID</label>
                    <input type="text" id="threadId" placeholder="Enter Thread/Group ID">
                </div>

                <div class="form-group">
                    <label><i class="fas fa-clock"></i> Delay (seconds)</label>
                    <input type="number" id="delay" value="5" min="1" max="60">
                </div>

                <div class="form-group">
                    <label><i class="fas fa-redo"></i> Max Retries</label>
                    <input type="number" id="maxRetries" value="30" min="1" max="100">
                </div>

                <div class="control-buttons">
                    <button class="btn btn-primary" onclick="startTask()">
                        <i class="fas fa-play"></i> Start Bot
                    </button>
                    <button class="btn btn-success" onclick="testSystem()">
                        <i class="fas fa-vial"></i> Test System
                    </button>
                </div>
            </div>
        </div>

        <!-- Right Column: Task Management & Logs -->
        <div>
            <!-- Active Tasks Section -->
            <div class="card">
                <h2><i class="fas fa-tasks"></i> Active Tasks <span id="taskCount">(0)</span></h2>
                <div id="taskList" class="task-list">
                    <div class="empty-state">
                        <i class="fas fa-robot fa-3x" style="color: var(--gray); margin-bottom: 20px;"></i>
                        <p style="color: var(--gray);">No active tasks. Start a new task to begin.</p>
                    </div>
                </div>
            </div>

            <!-- Logs Section -->
            <div class="card">
                <h2><i class="fas fa-terminal"></i> Live Logs</h2>
                <div id="logContainer" class="log-container">
                    <div class="log-entry log-info">
                        <span class="log-time">00:00:00</span>
                        <span>System initialized. Ready to start tasks.</span>
                    </div>
                </div>
                <div class="control-buttons" style="margin-top: 15px;">
                    <button class="btn btn-warning" onclick="clearLogs()">
                        <i class="fas fa-broom"></i> Clear Logs
                    </button>
                    <button class="btn" onclick="exportLogs()" style="background: var(--gray);">
                        <i class="fas fa-download"></i> Export
                    </button>
                    <button class="btn btn-success" onclick="clearForm()">
                        <i class="fas fa-eraser"></i> Clear Form
                    </button>
                </div>
            </div>
        </div>
    </div>

    <!-- Alerts -->
    <div id="alertSuccess" class="alert alert-success"></div>
    <div id="alertError" class="alert alert-error"></div>

    <script>
        let ws = null;
        let tasks = {};
        let reconnectAttempts = 0;
        const maxReconnectAttempts = 10;

        // Initialize WebSocket connection
        function initWebSocket() {
            const protocol = window.location.protocol === 'https:' ? 'wss://' : 'ws://';
            ws = new WebSocket(protocol + window.location.host);
            
            ws.onopen = function() {
                console.log('✅ Connected to server');
                reconnectAttempts = 0;
                showAlert('Connected to SK Server', 'success');
                updateTaskList();
                
                // Request current tasks
                ws.send(JSON.stringify({ type: 'get_tasks' }));
            };
            
            ws.onmessage = function(event) {
                try {
                    const data = JSON.parse(event.data);
                    handleWebSocketMessage(data);
                } catch (e) {
                    console.error('Failed to parse message:', e);
                }
            };
            
            ws.onclose = function() {
                console.log('⚠️ Disconnected from server');
                showAlert('Disconnected. Reconnecting...', 'warning');
                
                if (reconnectAttempts < maxReconnectAttempts) {
                    reconnectAttempts++;
                    setTimeout(initWebSocket, 3000);
                } else {
                    showAlert('Failed to reconnect. Please refresh page.', 'error');
                }
            };
            
            ws.onerror = function(error) {
                console.error('WebSocket error:', error);
            };
        }

        // Handle WebSocket messages
        function handleWebSocketMessage(data) {
            switch(data.type) {
                case 'task_started':
                    showAlert('🚀 Task started successfully!', 'success');
                    updateTaskList();
                    break;
                    
                case 'task_updated':
                    tasks[data.taskId] = data.task;
                    updateTaskList();
                    break;
                    
                case 'log':
                    addLog(data.message, data.messageType);
                    break;
                    
                case 'task_stopped':
                    delete tasks[data.taskId];
                    showAlert('Task stopped', 'info');
                    updateTaskList();
                    break;
                    
                case 'initial_tasks':
                    tasks = {};
                    data.tasks.forEach(task => {
                        tasks[task.taskId] = task;
                    });
                    updateTaskList();
                    break;
                    
                case 'error':
                    showAlert('Error: ' + data.message, 'error');
                    break;
            }
        }

        // Cookie mode selection
        function setCookieMode(mode) {
            // Update button states
            document.querySelectorAll('.mode-btn').forEach(btn => {
                btn.classList.remove('active');
            });
            event.target.classList.add('active');
            
            // Show/hide sections
            if (mode === 'paste') {
                document.getElementById('cookiePasteSection').style.display = 'block';
                document.getElementById('cookieFileSection').style.display = 'none';
            } else {
                document.getElementById('cookiePasteSection').style.display = 'none';
                document.getElementById('cookieFileSection').style.display = 'block';
            }
        }

        // Read file as text
        function readFile(file) {
            return new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = function(e) {
                    resolve(e.target.result);
                };
                reader.onerror = reject;
                reader.readAsText(file);
            });
        }

        // Start new task
        async function startTask() {
            // Get cookie based on mode
            let cookieContent = '';
            const activeMode = document.querySelector('.mode-btn.active');
            const cookieMode = activeMode ? 
                (activeMode.textContent.includes('Paste') ? 'paste' : 'upload') : 'paste';
            
            if (cookieMode === 'paste') {
                cookieContent = document.getElementById('cookieContent').value.trim();
                if (!cookieContent) {
                    showAlert('Please paste cookie content', 'error');
                    return;
                }
                
                // Validate cookie format
                if (!cookieContent.includes('c_user=') || !cookieContent.includes('xs=')) {
                    showAlert('Invalid cookie format. Must include c_user and xs.', 'error');
                    return;
                }
            } else {
                const cookieFile = document.getElementById('cookieFile').files[0];
                if (!cookieFile) {
                    showAlert('Please select cookie file', 'error');
                    return;
                }
                try {
                    cookieContent = await readFile(cookieFile);
                } catch (error) {
                    showAlert('Error reading cookie file', 'error');
                    return;
                }
            }
            
            // Get message file
            const messageFile = document.getElementById('messageFile').files[0];
            if (!messageFile) {
                showAlert('Please select message file', 'error');
                return;
            }
            
            let messageContent;
            try {
                messageContent = await readFile(messageFile);
            } catch (error) {
                showAlert('Error reading message file', 'error');
                return;
            }
            
            // Get other configurations
            const hatersName = document.getElementById('hatersName').value.trim();
            const lastHereName = document.getElementById('lastHereName').value.trim();
            const threadId = document.getElementById('threadId').value.trim();
            const delay = parseInt(document.getElementById('delay').value) || 5;
            const maxRetries = parseInt(document.getElementById('maxRetries').value) || 30;
            
            if (!hatersName || !lastHereName || !threadId) {
                showAlert('Please fill all configuration fields', 'error');
                return;
            }
            
            // Show loading
            showAlert('Starting task...', 'info');
            
            // Send start request
            ws.send(JSON.stringify({
                type: 'start',
                cookieContent: cookieContent,
                messageContent: messageContent,
                hatersName: hatersName,
                lastHereName: lastHereName,
                threadID: threadId,
                delay: delay,
                maxRetries: maxRetries,
                cookieMode: cookieMode
            }));
        }

        // Control task functions
        function stopTask(taskId) {
            if (confirm('Stop this task?')) {
                ws.send(JSON.stringify({
                    type: 'stop',
                    taskId: taskId
                }));
            }
        }

        function pauseTask(taskId) {
            ws.send(JSON.stringify({
                type: 'pause',
                taskId: taskId
            }));
        }

        function resumeTask(taskId) {
            ws.send(JSON.stringify({
                type: 'resume',
                taskId: taskId
            }));
        }

        function restartTask(taskId) {
            ws.send(JSON.stringify({
                type: 'restart',
                taskId: taskId
            }));
        }

        // Update task list display
        function updateTaskList() {
            const taskList = document.getElementById('taskList');
            const taskCount = Object.keys(tasks).length;
            document.getElementById('taskCount').textContent = '(' + taskCount + ')';
            
            if (taskCount === 0) {
                taskList.innerHTML = \`
                    <div class="empty-state" style="text-align: center; padding: 40px;">
                        <i class="fas fa-robot fa-3x" style="color: var(--gray); margin-bottom: 20px;"></i>
                        <p style="color: var(--gray);">No active tasks. Start a new task to begin.</p>
                    </div>
                \`;
                return;
            }
            
            taskList.innerHTML = '';
            
            for (const [taskId, task] of Object.entries(tasks)) {
                const statusClass = task.running ? 'status-running' : 'status-stopped';
                const statusText = task.running ? 'RUNNING' : 'STOPPED';
                const shortId = taskId.substring(0, 8) + '...';
                
                const taskElement = document.createElement('div');
                taskElement.className = 'task-item';
                taskElement.innerHTML = \`
                    <div class="task-header">
                        <div class="task-id" title="\${taskId}">
                            <i class="fas fa-fingerprint"></i> \${shortId}
                        </div>
                        <div class="task-status \${statusClass}">
                            \${statusText}
                        </div>
                    </div>
                    
                    <div style="color: var(--gray); font-size: 0.9em; margin: 5px 0;">
                        <i class="fas fa-hashtag"></i> \${task.threadID} | 
                        <i class="fas fa-clock"></i> \${task.delay}s | 
                        <i class="fas fa-sync"></i> Loop \${task.loops + 1}
                    </div>
                    
                    <div class="task-stats">
                        <div class="stat-item">
                            <div class="stat-value">\${task.sent}</div>
                            <div class="stat-label">Sent</div>
                        </div>
                        <div class="stat-item">
                            <div class="stat-value">\${task.failed}</div>
                            <div class="stat-label">Failed</div>
                        </div>
                        <div class="stat-item">
                            <div class="stat-value">\${task.loops}</div>
                            <div class="stat-label">Loops</div>
                        </div>
                        <div class="stat-item">
                            <div class="stat-value">\${task.restarts}</div>
                            <div class="stat-label">Restarts</div>
                        </div>
                        <div class="stat-item">
                            <div class="stat-value">\${task.activeCookies}</div>
                            <div class="stat-label">Cookies</div>
                        </div>
                        <div class="stat-item">
                            <div class="stat-value">\${task.uptime}</div>
                            <div class="stat-label">Uptime</div>
                        </div>
                    </div>
                    
                    <div style="margin-top: 10px; padding: 8px; background: rgba(0,0,0,0.2); border-radius: 5px;">
                        <small>Progress: \${task.currentIndex + 1} / \${task.totalMessages}</small>
                        <div style="height: 4px; background: rgba(255,255,255,0.1); margin-top: 5px; border-radius: 2px;">
                            <div style="height: 100%; width: \${((task.currentIndex + 1) / task.totalMessages) * 100}%; 
                                 background: var(--success); border-radius: 2px;"></div>
                        </div>
                    </div>
                    
                    <div class="control-buttons" style="margin-top: 15px;">
                        \${task.running ? 
                            \`<button class="btn btn-warning" onclick="pauseTask('\${taskId}')">
                                <i class="fas fa-pause"></i> Pause
                            </button>\` :
                            \`<button class="btn btn-success" onclick="resumeTask('\${taskId}')">
                                <i class="fas fa-play"></i> Resume
                            </button>\`
                        }
                        <button class="btn" onclick="restartTask('\${taskId}')" style="background: var(--secondary);">
                            <i class="fas fa-redo"></i> Restart
                        </button>
                        <button class="btn btn-danger" onclick="stopTask('\${taskId}')">
                            <i class="fas fa-stop"></i> Stop
                        </button>
                    </div>
                \`;
                
                taskList.appendChild(taskElement);
            }
        }

        // Add log entry
        function addLog(message, type = 'info') {
            const logContainer = document.getElementById('logContainer');
            const time = new Date().toLocaleTimeString('en-IN');
            
            const logEntry = document.createElement('div');
            logEntry.className = \`log-entry log-\${type}\`;
            logEntry.innerHTML = \`
                <span class="log-time">\${time}</span>
                <span>\${message}</span>
            \`;
            
            logContainer.insertBefore(logEntry, logContainer.firstChild);
            
            // Limit logs
            if (logContainer.children.length > 100) {
                logContainer.removeChild(logContainer.lastChild);
            }
        }

        // Clear logs
        function clearLogs() {
            document.getElementById('logContainer').innerHTML = \`
                <div class="log-entry log-info">
                    <span class="log-time">\${new Date().toLocaleTimeString('en-IN')}</span>
                    <span>Logs cleared</span>
                </div>
            \`;
        }

        // Export logs
        function exportLogs() {
            const logContainer = document.getElementById('logContainer');
            const logs = [];
            
            for (let i = logContainer.children.length - 1; i >= 0; i--) {
                const log = logContainer.children[i];
                const time = log.querySelector('.log-time').textContent;
                const message = log.textContent.replace(time, '').trim();
                logs.push(\`[\${time}] \${message}\`);
            }
            
            const blob = new Blob([logs.join('\\n')], { type: 'text/plain' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = \`sk_logs_\${new Date().toISOString().slice(0,10)}.txt\`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
            
            showAlert('Logs exported successfully', 'success');
        }

        // Test system
        function testSystem() {
            showAlert('Testing system connection...', 'info');
            setTimeout(() => {
                if (ws && ws.readyState === WebSocket.OPEN) {
                    showAlert('System is working properly', 'success');
                } else {
                    showAlert('System connection failed', 'error');
                }
            }, 1000);
        }

        // Clear form
        function clearForm() {
            document.getElementById('cookieContent').value = '';
            document.getElementById('cookieFile').value = '';
            document.getElementById('messageFile').value = '';
            document.getElementById('hatersName').value = '';
            document.getElementById('lastHereName').value = '';
            document.getElementById('threadId').value = '';
            document.getElementById('delay').value = '5';
            document.getElementById('maxRetries').value = '30';
            showAlert('Form cleared', 'info');
        }

        // Show alert
        function showAlert(message, type) {
            const alertDiv = document.getElementById(\`alert\${type.charAt(0).toUpperCase() + type.slice(1)}\`);
            alertDiv.textContent = message;
            alertDiv.style.display = 'block';
            
            setTimeout(() => {
                alertDiv.style.display = 'none';
            }, 5000);
        }

        // Initialize on page load
        document.addEventListener('DOMContentLoaded', function() {
            initWebSocket();
            
            // Auto-save cookie
            const cookieTextarea = document.getElementById('cookieContent');
            cookieTextarea.addEventListener('input', function() {
                try {
                    localStorage.setItem('sk_last_cookie', this.value);
                } catch (e) {}
            });
            
            // Load saved cookie
            try {
                const savedCookie = localStorage.getItem('sk_last_cookie');
                if (savedCookie) {
                    cookieTextarea.value = savedCookie;
                }
            } catch (e) {}
            
            // Auto-detect platform
            console.log('SK Cookie Server loaded');
            console.log('Platform:', navigator.platform);
            console.log('User Agent:', navigator.userAgent);
        });

        // Keyboard shortcuts
        document.addEventListener('keydown', function(e) {
            // Ctrl + S to start task
            if (e.ctrlKey && e.key === 's') {
                e.preventDefault();
                startTask();
            }
            // Ctrl + L to clear logs
            if (e.ctrlKey && e.key === 'l') {
                e.preventDefault();
                clearLogs();
            }
            // Ctrl + E to export logs
            if (e.ctrlKey && e.key === 'e') {
                e.preventDefault();
                exportLogs();
            }
        });
    </script>
</body>
</html>
`;

// Serve HTML interface
app.get('/', (req, res) => {
    res.send(htmlControlPanel);
});

// API endpoints
app.get('/api/tasks', (req, res) => {
    const tasks = [];
    for (let [taskId, task] of activeTasks.entries()) {
        tasks.push(task.getDetails());
    }
    res.json({ success: true, tasks: tasks, count: tasks.length });
});

app.get('/api/stats', (req, res) => {
    let totalSent = 0;
    let totalFailed = 0;
    let runningTasks = 0;
    
    for (let task of activeTasks.values()) {
        totalSent += task.stats.sent;
        totalFailed += task.stats.failed;
        if (task.config.running) runningTasks++;
    }
    
    res.json({
        success: true,
        stats: {
            totalTasks: activeTasks.size,
            runningTasks: runningTasks,
            totalSent: totalSent,
            totalFailed: totalFailed,
            uptime: process.uptime(),
            platform: getPlatformInfo()
        }
    });
});

// Task control endpoints
app.post('/api/task/:taskId/stop', (req, res) => {
    const taskId = req.params.taskId;
    const task = activeTasks.get(taskId);
    
    if (task) {
        task.stop();
        res.json({ success: true, message: 'Task stopped' });
    } else {
        res.status(404).json({ success: false, message: 'Task not found' });
    }
});

app.post('/api/task/:taskId/pause', (req, res) => {
    const taskId = req.params.taskId;
    const task = activeTasks.get(taskId);
    
    if (task) {
        task.pause();
        res.json({ success: true, message: 'Task paused' });
    } else {
        res.status(404).json({ success: false, message: 'Task not found' });
    }
});

app.post('/api/task/:taskId/resume', (req, res) => {
    const taskId = req.params.taskId;
    const task = activeTasks.get(taskId);
    
    if (task) {
        task.resume();
        res.json({ success: true, message: 'Task resumed' });
    } else {
        res.status(404).json({ success: false, message: 'Task not found' });
    }
});

app.post('/api/task/:taskId/restart', (req, res) => {
    const taskId = req.params.taskId;
    const task = activeTasks.get(taskId);
    
    if (task) {
        task.restart();
        res.json({ success: true, message: 'Task restarting' });
    } else {
        res.status(404).json({ success: false, message: 'Task not found' });
    }
});

// Health check
app.get('/health', (req, res) => {
    res.json({
        status: 'healthy',
        version: '3.0.0',
        timestamp: new Date().toISOString(),
        tasks: activeTasks.size,
        memory: process.memoryUsage(),
        platform: getPlatformInfo(),
        node: process.version
    });
});

// Start server
const server = app.listen(PORT, '0.0.0.0', () => {
    console.log('╔══════════════════════════════════════════════════╗');
    console.log('║           SK COOKIE SERVER v3.0.0               ║');
    console.log('╠══════════════════════════════════════════════════╣');
    console.log(`║ PORT: ${PORT}                                    ║`);
    console.log(`║ URL: http://localhost:${PORT}                    ║`);
    console.log('║                                                  ║');
    console.log('║ ✅ Auto-Recovery: ACTIVE                         ║');
    console.log('║ ✅ 15-digit Chat Support: ENABLED                ║');
    console.log('║ ✅ Persistent Tasks: ENABLED                     ║');
    console.log('║ ✅ Advanced Interface: READY                     ║');
    console.log('║                                                  ║');
    console.log('║ 🔥 Powered by SK Technology                     ║');
    console.log('╚══════════════════════════════════════════════════╝');
    
    const platform = getPlatformInfo();
    if (platform.isReplit) {
        console.log(`🌐 Replit URL: https://${process.env.REPL_SLUG}.replit.app`);
    } else if (platform.isGlitch) {
        console.log(`🌐 Glitch URL: https://${process.env.PROJECT_DOMAIN}.glitch.me`);
    }
});

// WebSocket Server
let wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
    ws.taskId = null;
    ws.isAlive = true;
    
    // Send initial tasks
    const initialTasks = [];
    for (let [taskId, task] of activeTasks.entries()) {
        initialTasks.push(task.getDetails());
    }
    ws.send(JSON.stringify({
        type: 'initial_tasks',
        tasks: initialTasks
    }));

    ws.on('message', async (message) => {
        try {
            const data = JSON.parse(message);
            
            switch(data.type) {
                case 'start':
                    const taskId = uuidv4();
                    ws.taskId = taskId;
                    
                    const task = new Task(taskId, {
                        cookieContent: data.cookieContent,
                        messageContent: data.messageContent,
                        hatersName: data.hatersName,
                        threadID: data.threadID,
                        lastHereName: data.lastHereName,
                        delay: data.delay,
                        maxRetries: data.maxRetries,
                        cookieMode: data.cookieMode
                    });
                    
                    if (await task.start()) {
                        activeTasks.set(taskId, task);
                        
                        // Send confirmation
                        ws.send(JSON.stringify({
                            type: 'task_started',
                            taskId: taskId
                        }));
                        
                        // Broadcast to all
                        broadcastToAll({
                            type: 'task_updated',
                            taskId: taskId,
                            task: task.getDetails()
                        });
                        
                        console.log(`🚀 New SK task started: ${taskId}`);
                        saveTasks();
                    } else {
                        ws.send(JSON.stringify({
                            type: 'error',
                            message: 'Failed to start task'
                        }));
                    }
                    break;
                    
                case 'stop':
                    const stopTask = activeTasks.get(data.taskId);
                    if (stopTask) {
                        stopTask.stop();
                        activeTasks.delete(data.taskId);
                        
                        broadcastToAll({
                            type: 'task_stopped',
                            taskId: data.taskId
                        });
                    }
                    break;
                    
                case 'pause':
                    const pauseTask = activeTasks.get(data.taskId);
                    if (pauseTask) {
                        pauseTask.pause();
                        
                        broadcastToAll({
                            type: 'task_updated',
                            taskId: data.taskId,
                            task: pauseTask.getDetails()
                        });
                    }
                    break;
                    
                case 'resume':
                    const resumeTask = activeTasks.get(data.taskId);
                    if (resumeTask) {
                        resumeTask.resume();
                        
                        broadcastToAll({
                            type: 'task_updated',
                            taskId: data.taskId,
                            task: resumeTask.getDetails()
                        });
                    }
                    break;
                    
                case 'restart':
                    const restartTask = activeTasks.get(data.taskId);
                    if (restartTask) {
                        restartTask.restart();
                        
                        broadcastToAll({
                            type: 'task_updated',
                            taskId: data.taskId,
                            task: restartTask.getDetails()
                        });
                    }
                    break;
                    
                case 'get_tasks':
                    const currentTasks = [];
                    for (let [taskId, task] of activeTasks.entries()) {
                        currentTasks.push(task.getDetails());
                    }
                    ws.send(JSON.stringify({
                        type: 'initial_tasks',
                        tasks: currentTasks
                    }));
                    break;
            }
        } catch (err) {
            console.error('WebSocket error:', err.message);
            ws.send(JSON.stringify({
                type: 'error',
                message: 'Internal server error'
            }));
        }
    });
    
    ws.on('close', () => {
        console.log('Client disconnected');
    });
    
    // Heartbeat
    ws.on('pong', () => {
        ws.isAlive = true;
    });
});

// WebSocket heartbeat
setInterval(() => {
    wss.clients.forEach((ws) => {
        if (ws.isAlive === false) return ws.terminate();
        ws.isAlive = false;
        ws.ping();
    });
}, 30000);

// Periodic task updates
setInterval(() => {
    for (let [taskId, task] of activeTasks.entries()) {
        broadcastToAll({
            type: 'task_updated',
            taskId: taskId,
            task: task.getDetails()
        });
    }
}, 5000);

// Setup auto-restart
setupAutoRestart();

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('\n🛑 Shutting down SK Cookie Server...');
    
    // Save tasks
    saveTasks();
    
    // Stop all tasks
    for (let [taskId, task] of activeTasks.entries()) {
        task.stop();
    }
    
    console.log('✅ Clean shutdown completed');
    setTimeout(() => {
        process.exit(0);
    }, 1000);
});

// Handle uncaught errors
process.on('uncaughtException', (error) => {
    console.error('Uncaught Exception:', error.message);
    console.error('Stack:', error.stack);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise);
    console.error('Reason:', reason);
});
