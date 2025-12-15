const { app, BrowserWindow, ipcMain, Menu } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const http = require('http');

// ============ Configuration ============
const API_BASE = 'http://127.0.0.1:5000';
let pythonProcess = null;
let mainWindow = null;

// ============ Python Server Manager ============
function getPythonScriptPath() {
    // When packaged, resources are in app.getPath('exe')/../resources/virtualSiemens
    // When in dev, it's in ../virtualSiemens relative to __dirname
    if (app.isPackaged) {
        return path.join(process.resourcesPath, 'virtualSiemens', 'virtual_plc_s7.py');
    } else {
        return path.join(__dirname, '..', 'virtualSiemens', 'virtual_plc_s7.py');
    }
}

function getPythonCwd() {
    if (app.isPackaged) {
        return path.join(process.resourcesPath, 'virtualSiemens');
    } else {
        return path.join(__dirname, '..', 'virtualSiemens');
    }
}

function startPythonServer() {
    const pythonScript = getPythonScriptPath();
    const cwd = getPythonCwd();

    console.log('Starting Python Virtual PLC Server...');
    console.log('Script path:', pythonScript);
    console.log('Working directory:', cwd);

    // Try python3 first, then python
    pythonProcess = spawn('python', [pythonScript], {
        cwd: cwd,
        stdio: ['pipe', 'pipe', 'pipe']
    });

    pythonProcess.stdout.on('data', (data) => {
        console.log(`[Python] ${data.toString().trim()}`);
    });

    pythonProcess.stderr.on('data', (data) => {
        console.error(`[Python Error] ${data.toString().trim()}`);
    });

    pythonProcess.on('close', (code) => {
        console.log(`Python process exited with code ${code}`);
        pythonProcess = null;
    });

    pythonProcess.on('error', (err) => {
        console.error('Failed to start Python process:', err);
        pythonProcess = null;
    });

    return pythonProcess;
}

function stopPythonServer() {
    if (pythonProcess) {
        console.log('Stopping Python server...');
        pythonProcess.kill();
        pythonProcess = null;
    }
}

// ============ HTTP Client for Flask API ============
function makeRequest(method, endpoint, data = null) {
    return new Promise((resolve, reject) => {
        const url = new URL(endpoint, API_BASE);

        const options = {
            hostname: url.hostname,
            port: url.port,
            path: url.pathname + url.search,
            method: method,
            headers: {
                'Content-Type': 'application/json',
            },
            timeout: 5000
        };

        const req = http.request(options, (res) => {
            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => {
                try {
                    const json = JSON.parse(body);
                    resolve(json);
                } catch (e) {
                    resolve(body);
                }
            });
        });

        req.on('error', (e) => {
            console.error('API request error:', e.message);
            reject(e);
        });

        req.on('timeout', () => {
            req.destroy();
            reject(new Error('Request timeout'));
        });

        if (data) {
            req.write(JSON.stringify(data));
        }
        req.end();
    });
}

// ============ Electron App ============
function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1400,
        height: 900,
        minWidth: 1000,
        minHeight: 700,
        frame: false,
        transparent: false,
        backgroundColor: '#ffffff',
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, 'preload.js')
        },
        icon: path.join(__dirname, 'assets', 'icon.png')
    });

    mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

    // DevTools in dev mode
    if (process.argv.includes('--dev')) {
        mainWindow.webContents.openDevTools();
    }

    Menu.setApplicationMenu(null);
}

// ============ IPC Handlers ============
function setupIPC() {
    // Window controls
    ipcMain.handle('window:minimize', () => mainWindow.minimize());
    ipcMain.handle('window:maximize', () => {
        if (mainWindow.isMaximized()) {
            mainWindow.unmaximize();
        } else {
            mainWindow.maximize();
        }
    });
    ipcMain.handle('window:close', () => mainWindow.close());

    // PLC operations - proxy to Python Flask API
    ipcMain.handle('plc:getAll', async () => {
        try {
            return await makeRequest('GET', '/api/plcs');
        } catch (e) {
            console.error('Failed to get PLCs:', e);
            return [];
        }
    });

    ipcMain.handle('plc:getDataBlocks', async (event, plcName) => {
        try {
            return await makeRequest('GET', `/api/plc/${plcName}/dbs`);
        } catch (e) {
            console.error('Failed to get data blocks:', e);
            return [];
        }
    });

    // Read value
    ipcMain.handle('plc:readValue', async (event, { plcName, dbNumber, offset, dataType, bitOffset }) => {
        try {
            const result = await makeRequest('POST', '/api/read', {
                plc: plcName,
                db: dbNumber,
                offset: offset,
                type: dataType,
                bit: bitOffset || 0
            });
            return result.value;
        } catch (e) {
            console.error('Failed to read value:', e);
            return null;
        }
    });

    // Write value
    ipcMain.handle('plc:writeValue', async (event, { plcName, dbNumber, offset, dataType, value, bitOffset }) => {
        try {
            console.log('Writing:', { plcName, dbNumber, offset, dataType, value, bitOffset });
            const result = await makeRequest('POST', '/api/write', {
                plc: plcName,
                db: dbNumber,
                offset: offset,
                type: dataType,
                value: value,
                bit: bitOffset || 0
            });
            console.log('Write result:', result);
            return result.success;
        } catch (e) {
            console.error('Failed to write value:', e);
            return false;
        }
    });

    // Batch read for monitoring
    ipcMain.handle('plc:readMultiple', async (event, { plcName, addresses }) => {
        try {
            const formattedAddresses = addresses.map(addr => ({
                db: addr.dbNumber,
                offset: addr.offset,
                type: addr.dataType,
                bit: addr.bitOffset || 0
            }));

            const result = await makeRequest('POST', '/api/read/batch', {
                plc: plcName,
                addresses: formattedAddresses
            });

            // Map back to expected format
            return result.map((item, index) => ({
                ...addresses[index],
                value: item.value
            }));
        } catch (e) {
            console.error('Failed to batch read:', e);
            return addresses.map(addr => ({ ...addr, value: null }));
        }
    });

    // Server status
    ipcMain.handle('server:status', async () => {
        try {
            await makeRequest('GET', '/api/plcs');
            return { connected: true, pythonRunning: pythonProcess !== null };
        } catch (e) {
            return { connected: false, pythonRunning: pythonProcess !== null };
        }
    });

    ipcMain.handle('server:restart', async () => {
        stopPythonServer();
        await new Promise(resolve => setTimeout(resolve, 1000));
        startPythonServer();
        return { success: true };
    });
}

// Wait for Flask server to be ready
function waitForServer(maxRetries = 30, delay = 1000) {
    return new Promise((resolve, reject) => {
        let retries = 0;

        const check = () => {
            makeRequest('GET', '/api/plcs')
                .then(() => {
                    console.log('Flask server is ready!');
                    resolve(true);
                })
                .catch(() => {
                    retries++;
                    if (retries < maxRetries) {
                        console.log(`Waiting for Flask server... (${retries}/${maxRetries})`);
                        setTimeout(check, delay);
                    } else {
                        reject(new Error('Flask server did not start in time'));
                    }
                });
        };

        check();
    });
}

// App lifecycle
app.whenReady().then(async () => {
    // Start Python server first
    startPythonServer();

    // Wait a bit for Flask to initialize
    console.log('Waiting for Python Flask server to start...');

    try {
        await waitForServer(30, 1000);
    } catch (e) {
        console.error('Warning: Could not connect to Flask server. Please ensure Python is installed and flask-cors is available.');
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
