const { app, BrowserWindow, ipcMain, Menu } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const http = require('http');

const API_BASE = 'http://127.0.0.1:5000';

let pythonProcess = null;
let mainWindow = null;

function getResourceRoot() {
    return app.isPackaged ? process.resourcesPath : path.join(__dirname, '..');
}

function getPythonScriptPath() {
    return path.join(getResourceRoot(), 'virtualHub', 'virtual_plc_hub.py');
}

function startPythonServer() {
    if (pythonProcess) {
        return pythonProcess;
    }

    const scriptPath = getPythonScriptPath();
    const cwd = getResourceRoot();

    console.log('Starting Virtual PLC Hub...');
    console.log('Script path:', scriptPath);
    console.log('Working directory:', cwd);

    pythonProcess = spawn('python', [scriptPath], {
        cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
            ...process.env,
            PYTHONUNBUFFERED: '1'
        }
    });

    pythonProcess.stdout.on('data', (data) => {
        console.log(`[Virtual PLC Hub] ${data.toString().trim()}`);
    });

    pythonProcess.stderr.on('data', (data) => {
        console.error(`[Virtual PLC Hub Error] ${data.toString().trim()}`);
    });

    pythonProcess.on('close', (code) => {
        console.log(`Virtual PLC Hub exited with code ${code}`);
        pythonProcess = null;
    });

    pythonProcess.on('error', (err) => {
        console.error('Failed to start Virtual PLC Hub:', err);
        pythonProcess = null;
    });

    return pythonProcess;
}

function stopPythonServer() {
    if (!pythonProcess) {
        return;
    }
    console.log('Stopping Virtual PLC Hub...');
    pythonProcess.kill();
    pythonProcess = null;
}

function makeRequest(method, endpoint, data = null) {
    return new Promise((resolve, reject) => {
        const url = new URL(endpoint, API_BASE);
        const body = data === null ? null : JSON.stringify(data);

        const options = {
            hostname: url.hostname,
            port: url.port,
            path: url.pathname + url.search,
            method,
            headers: {
                'Content-Type': 'application/json',
                ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {})
            },
            timeout: 6000
        };

        const req = http.request(options, (res) => {
            let responseBody = '';
            res.on('data', (chunk) => {
                responseBody += chunk;
            });
            res.on('end', () => {
                if (!responseBody) {
                    resolve({ success: res.statusCode < 400 });
                    return;
                }
                try {
                    resolve(JSON.parse(responseBody));
                } catch {
                    resolve(responseBody);
                }
            });
        });

        req.on('error', reject);
        req.on('timeout', () => {
            req.destroy();
            reject(new Error('Request timeout'));
        });

        if (body) {
            req.write(body);
        }
        req.end();
    });
}

function encodeName(name) {
    return encodeURIComponent(name);
}

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1440,
        height: 920,
        minWidth: 1080,
        minHeight: 720,
        frame: false,
        transparent: false,
        backgroundColor: '#f4f7f9',
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, 'preload.js')
        },
        icon: path.join(__dirname, 'assets', 'icon.png')
    });

    mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

    if (process.argv.includes('--dev')) {
        mainWindow.webContents.openDevTools();
    }

    Menu.setApplicationMenu(null);
}

function setupIPC() {
    ipcMain.handle('window:minimize', () => mainWindow.minimize());
    ipcMain.handle('window:maximize', () => {
        if (mainWindow.isMaximized()) {
            mainWindow.unmaximize();
        } else {
            mainWindow.maximize();
        }
    });
    ipcMain.handle('window:close', () => mainWindow.close());

    ipcMain.handle('profiles:getAll', async () => {
        try {
            return await makeRequest('GET', '/api/profiles');
        } catch (error) {
            console.error('Failed to get profiles:', error);
            return [];
        }
    });

    ipcMain.handle('plc:getAll', async () => {
        try {
            return await makeRequest('GET', '/api/plcs');
        } catch (error) {
            console.error('Failed to get PLCs:', error);
            return [];
        }
    });

    ipcMain.handle('plc:create', async (_event, payload) => {
        try {
            return await makeRequest('POST', '/api/plcs', payload);
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('plc:update', async (_event, payload) => {
        const { oldName, ...body } = payload;
        try {
            return await makeRequest('PUT', `/api/plcs/${encodeName(oldName)}`, body);
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('plc:delete', async (_event, payload) => {
        try {
            return await makeRequest('DELETE', `/api/plcs/${encodeName(payload.name)}`);
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('plc:getDataBlocks', async (_event, plcName) => {
        try {
            const response = await makeRequest('GET', `/api/plc/${encodeName(plcName)}/dbs`);
            return Array.isArray(response) ? response : [];
        } catch (error) {
            console.error('Failed to get data blocks:', error);
            return [];
        }
    });

    ipcMain.handle('plc:addDB', async (_event, payload) => {
        try {
            return await makeRequest('POST', `/api/plc/${encodeName(payload.plcName)}/dbs`, {
                dbNumber: payload.dbNumber,
                size: payload.size
            });
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('plc:updateDB', async (_event, payload) => {
        try {
            return await makeRequest('PUT', `/api/plc/${encodeName(payload.plcName)}/dbs/${payload.oldDbNumber}`, {
                dbNumber: payload.newDbNumber,
                size: payload.newSize
            });
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('plc:removeDB', async (_event, payload) => {
        try {
            return await makeRequest('DELETE', `/api/plc/${encodeName(payload.plcName)}/dbs/${payload.dbNumber}`);
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('plc:readValue', async (_event, payload) => {
        try {
            const result = await makeRequest('POST', '/api/read', payload);
            return result && Object.prototype.hasOwnProperty.call(result, 'value') ? result.value : null;
        } catch (error) {
            console.error('Failed to read value:', error);
            return null;
        }
    });

    ipcMain.handle('plc:writeValue', async (_event, payload) => {
        try {
            return await makeRequest('POST', '/api/write', payload);
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('plc:readMultiple', async (_event, payload) => {
        try {
            const result = await makeRequest('POST', '/api/read/batch', payload);
            return Array.isArray(result) ? result : [];
        } catch (error) {
            console.error('Failed to batch read:', error);
            return (payload.addresses || []).map((address) => ({ ...address, value: null, quality: 'Bad', error: error.message }));
        }
    });

    ipcMain.handle('server:status', async () => {
        try {
            const result = await makeRequest('GET', '/api/status');
            return {
                connected: true,
                pythonRunning: pythonProcess !== null,
                ...result
            };
        } catch {
            return { connected: false, pythonRunning: pythonProcess !== null, plcs: 0 };
        }
    });

    ipcMain.handle('server:restart', async () => {
        stopPythonServer();
        await new Promise((resolve) => setTimeout(resolve, 800));
        startPythonServer();
        return { success: true };
    });
}

function waitForServer(maxRetries = 30, delay = 1000) {
    return new Promise((resolve, reject) => {
        let retries = 0;

        const check = () => {
            makeRequest('GET', '/api/status')
                .then(() => resolve(true))
                .catch(() => {
                    retries += 1;
                    if (retries < maxRetries) {
                        setTimeout(check, delay);
                    } else {
                        reject(new Error('Virtual PLC Hub did not start in time'));
                    }
                });
        };

        check();
    });
}

app.whenReady().then(async () => {
    startPythonServer();

    try {
        await waitForServer();
    } catch (error) {
        console.error(error.message);
    }

    createWindow();
    setupIPC();
});

app.on('window-all-closed', () => {
    stopPythonServer();
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

app.on('before-quit', () => {
    stopPythonServer();
});

app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
    }
});
