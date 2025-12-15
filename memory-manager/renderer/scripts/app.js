// ============================================
// Memory Region Manager - Frontend Application
// ============================================

class App {
    constructor() {
        this.currentPLC = 'PLC_1';
        this.currentView = 'regions';
        this.monitorItems = [];
        this.monitorInterval = null;
        this.writeRows = [];
        this.plcList = [];

        this.init();
    }

    async init() {
        this.bindWindowControls();
        this.bindNavigation();
        this.bindPLCSelector();
        this.bindMonitorControls();
        this.bindWriteControls();
        this.bindModal();
        this.bindPLCSettings();

        // Check server status
        await this.updateServerStatus();

        await this.loadPLCList();
        await this.loadDataBlocks();
        this.startMonitor();
        this.addWriteRow();

        // Periodically check server status
        setInterval(() => this.updateServerStatus(), 5000);
    }

    async updateServerStatus() {
        try {
            const status = await window.electronAPI.getServerStatus();
            const indicator = document.querySelector('.status-indicator');
            const dot = document.querySelector('.status-dot');
            const text = indicator?.querySelector('span:last-child');

            if (status.connected) {
                dot?.classList.add('online');
                dot?.classList.remove('offline');
                if (text) text.textContent = 'S7 Server Connected';
            } else {
                dot?.classList.remove('online');
                dot?.classList.add('offline');
                if (text) text.textContent = 'S7 Server Disconnected';
            }
        } catch (e) {
            console.error('Failed to check server status:', e);
        }
    }



    // ============ Window Controls ============
    bindWindowControls() {
        document.getElementById('btn-minimize').addEventListener('click', () => {
            window.electronAPI.minimize();
        });

        document.getElementById('btn-maximize').addEventListener('click', () => {
            window.electronAPI.maximize();
        });

        document.getElementById('btn-close').addEventListener('click', () => {
            window.electronAPI.close();
        });
    }

    // ============ Navigation ============
    bindNavigation() {
        document.querySelectorAll('.nav-item').forEach(btn => {
            btn.addEventListener('click', () => {
                const view = btn.dataset.view;
                this.switchView(view);
            });
        });
    }

    switchView(view) {
        this.currentView = view;

        // Update nav items
        document.querySelectorAll('.nav-item').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.view === view);
        });

        // Update views
        document.querySelectorAll('.view').forEach(v => {
            v.classList.toggle('active', v.id === `view-${view}`);
        });

        // Refresh data for the view
        if (view === 'regions') {
            this.loadDataBlocks();
        } else if (view === 'monitor') {
            this.updateMonitorDBOptions();
        }
    }

    // ============ PLC Selector ============
    bindPLCSelector() {
        document.querySelectorAll('.plc-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                this.selectPLC(btn.dataset.plc);
            });
        });
    }

    selectPLC(plcName) {
        this.currentPLC = plcName;

        document.querySelectorAll('.plc-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.plc === plcName);
        });

        // Reload current view data
        if (this.currentView === 'regions') {
            this.loadDataBlocks();
        }
        this.updateMonitorDBOptions();
    }

    // ============ Data Blocks ============
    async loadDataBlocks() {
        const blocks = await window.electronAPI.getDataBlocks(this.currentPLC);
        this.renderDataBlocks(blocks);
    }

    renderDataBlocks(blocks) {
        const tbody = document.getElementById('db-table-body');

        if (blocks.length === 0) {
            tbody.innerHTML = `
        <tr>
          <td colspan="4">
            <div class="empty-state">
              <div class="empty-state-icon">
                <svg class="icon" style="width:32px;height:32px" viewBox="0 0 24 24"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>
              </div>
              <div class="empty-state-text">No Data Blocks configured</div>
            </div>
          </td>
        </tr>
      `;
            return;
        }

        tbody.innerHTML = blocks.map(db => `
      <tr data-db="${db.dbNumber}">
        <td><span class="db-number">DB${db.dbNumber}</span></td>
        <td><span class="db-size">${db.size.toLocaleString()}</span></td>
        <td>
          <span class="status-badge active">
            <span class="status-dot online"></span>
            Active
          </span>
        </td>
        <td>
          <div class="action-btns">
            <button class="btn btn-icon btn-ghost" onclick="app.editDB(${db.dbNumber}, ${db.size})" title="Edit">
              <svg class="icon" viewBox="0 0 24 24"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>
            </button>
            <button class="btn btn-icon btn-ghost" onclick="app.monitorDB(${db.dbNumber})" title="Monitor">
              <svg class="icon" viewBox="0 0 24 24"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>
            </button>
            <button class="btn btn-icon btn-ghost" onclick="app.deleteDB(${db.dbNumber})" title="Delete">
              <svg class="icon" viewBox="0 0 24 24"><path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
            </button>
          </div>
        </td>
      </tr>
    `).join('');
    }

    // ============ Add DB Modal ============
    bindModal() {
        const overlay = document.getElementById('modal-overlay');
        const closeBtn = document.getElementById('modal-close');
        const cancelBtn = document.getElementById('modal-cancel');

        closeBtn.addEventListener('click', () => this.closeModal());
        cancelBtn.addEventListener('click', () => this.closeModal());
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) this.closeModal();
        });

        document.getElementById('btn-add-db').addEventListener('click', () => {
            this.showAddDBModal();
        });
    }

    showAddDBModal() {
        document.getElementById('modal-title').textContent = 'Add Data Block';
        document.getElementById('modal-body').innerHTML = `
      <div class="form-group">
        <label>DB Number</label>
        <input type="number" class="input" id="input-db-number" min="1" max="65535" value="100">
      </div>
      <div class="form-group">
        <label>Size (bytes)</label>
        <input type="number" class="input" id="input-db-size" min="1" max="65535" value="2000">
      </div>
    `;

        const confirmBtn = document.getElementById('modal-confirm');
        confirmBtn.onclick = () => this.addDB();

        this.openModal();
    }

    async addDB() {
        const dbNumber = parseInt(document.getElementById('input-db-number').value);
        const size = parseInt(document.getElementById('input-db-size').value);

        if (dbNumber && size) {
            await window.electronAPI.addDB(this.currentPLC, dbNumber, size);
            this.closeModal();
            await this.loadDataBlocks();
            this.updateMonitorDBOptions();
        }
    }

    editDB(dbNumber, currentSize) {
        document.getElementById('modal-title').textContent = 'Edit Data Block';
        document.getElementById('modal-body').innerHTML = `
      <div class="form-group">
        <label>DB Number</label>
        <input type="number" class="input" id="input-db-number" min="1" max="65535" value="${dbNumber}">
      </div>
      <div class="form-group">
        <label>Size (bytes)</label>
        <input type="number" class="input" id="input-db-size" min="1" max="65535" value="${currentSize}">
      </div>
    `;

        const confirmBtn = document.getElementById('modal-confirm');
        confirmBtn.onclick = async () => {
            const newDbNumber = parseInt(document.getElementById('input-db-number').value);
            const newSize = parseInt(document.getElementById('input-db-size').value);

            if (newDbNumber && newSize) {
                await window.electronAPI.updateDB(this.currentPLC, dbNumber, newDbNumber, newSize);
                this.closeModal();
                await this.loadDataBlocks();
                this.updateMonitorDBOptions();
            }
        };

        this.openModal();
    }

    async deleteDB(dbNumber) {
        document.getElementById('modal-title').textContent = 'Delete Data Block';
        document.getElementById('modal-body').innerHTML = `
      <p style="color: var(--text-secondary); margin-bottom: 16px;">
        Are you sure you want to delete <strong style="color: var(--danger);">DB${dbNumber}</strong>?
      </p>
      <p style="color: var(--text-muted); font-size: 13px;">
        This action cannot be undone. All data in this block will be lost.
      </p>
    `;

        const confirmBtn = document.getElementById('modal-confirm');
        confirmBtn.className = 'btn btn-danger';
        confirmBtn.textContent = 'Delete';
        confirmBtn.onclick = async () => {
            await window.electronAPI.removeDB(this.currentPLC, dbNumber);
            this.closeModal();
            confirmBtn.className = 'btn btn-primary';
            confirmBtn.textContent = 'Confirm';
            await this.loadDataBlocks();
            this.updateMonitorDBOptions();
        };

        this.openModal();
    }

    monitorDB(dbNumber) {
        // Switch to monitor view and add this DB
        this.switchView('monitor');
        document.getElementById('monitor-db').value = dbNumber;
    }

    openModal() {
        document.getElementById('modal-overlay').classList.add('active');
    }

    closeModal() {
        document.getElementById('modal-overlay').classList.remove('active');
    }

    // ============ Monitor ============
    bindMonitorControls() {
        document.getElementById('btn-add-monitor').addEventListener('click', () => {
            this.addMonitorItem();
        });

        document.getElementById('auto-refresh').addEventListener('change', (e) => {
            const indicator = document.getElementById('refresh-indicator');
            if (e.target.checked) {
                indicator.textContent = 'Live';
                indicator.classList.remove('paused');
                this.startMonitor();
            } else {
                indicator.textContent = 'Paused';
                indicator.classList.add('paused');
                this.stopMonitor();
            }
        });

        // Show/hide bit input based on type
        document.getElementById('monitor-type').addEventListener('change', (e) => {
            const bitInput = document.getElementById('monitor-bit');
            bitInput.style.display = e.target.value === 'BOOL' ? 'block' : 'none';
        });
    }

    async updateMonitorDBOptions() {
        const blocks = await window.electronAPI.getDataBlocks(this.currentPLC);
        const select = document.getElementById('monitor-db');

        select.innerHTML = blocks.map(db =>
            `<option value="${db.dbNumber}">DB${db.dbNumber}</option>`
        ).join('');
    }

    addMonitorItem() {
        const db = parseInt(document.getElementById('monitor-db').value);
        const offset = parseInt(document.getElementById('monitor-offset').value);
        const type = document.getElementById('monitor-type').value;
        const bit = parseInt(document.getElementById('monitor-bit').value) || 0;

        if (!db && db !== 0) return;

        const id = `${db}-${offset}-${type}-${bit}`;

        // Check if already exists
        if (this.monitorItems.find(item => item.id === id)) {
            return;
        }

        this.monitorItems.push({
            id,
            dbNumber: db,
            offset,
            dataType: type,
            bitOffset: bit,
            value: null
        });

        this.renderMonitorItems();
    }

    renderMonitorItems() {
        const grid = document.getElementById('monitor-grid');

        if (this.monitorItems.length === 0) {
            grid.innerHTML = `
        <div class="empty-state">
          <div class="empty-state-icon">
            <svg class="icon" style="width:32px;height:32px" viewBox="0 0 24 24"><path d="M3 3v18h18"/><path d="M18 9l-5 5-4-4-3 3"/></svg>
          </div>
          <div class="empty-state-text">Add addresses to monitor</div>
        </div>
      `;
            return;
        }

        grid.innerHTML = this.monitorItems.map(item => {
            const addressStr = item.dataType === 'BOOL'
                ? `DB${item.dbNumber}.DBX${item.offset}.${item.bitOffset}`
                : `DB${item.dbNumber}.DB${this.getTypePrefix(item.dataType)}${item.offset}`;

            const displayValue = item.value !== null ? this.formatValue(item.value, item.dataType) : '---';

            return `
        <div class="monitor-card" data-id="${item.id}">
          <button class="btn btn-icon btn-ghost btn-remove" onclick="app.removeMonitorItem('${item.id}')">
            <svg class="icon" viewBox="0 0 24 24"><path d="M6 6l12 12M6 18L18 6"/></svg>
          </button>
          <div class="monitor-card-header">
            <span class="monitor-card-title">${addressStr}</span>
            <span class="monitor-card-type">${item.dataType}</span>
          </div>
          <div class="monitor-card-value">${displayValue}</div>
          <div class="monitor-card-footer">
            <input type="text" class="input" id="write-${item.id}" placeholder="New value">
            <button class="btn btn-primary btn-icon" onclick="app.writeMonitorValue('${item.id}')">
              <svg class="icon" viewBox="0 0 24 24"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
            </button>
          </div>
        </div>
      `;
        }).join('');
    }

    getTypePrefix(type) {
        const prefixes = {
            'BOOL': 'X',
            'BYTE': 'B',
            'WORD': 'W',
            'DWORD': 'D',
            'INT': 'W',
            'DINT': 'D',
            'REAL': 'D',
            'STRING': 'B'
        };
        return prefixes[type] || 'B';
    }

    formatValue(value, type) {
        if (value === null || value === undefined) return '---';

        switch (type) {
            case 'BOOL':
                return value ? 'TRUE' : 'FALSE';
            case 'REAL':
                return typeof value === 'number' ? value.toFixed(3) : value;
            default:
                return String(value);
        }
    }

    removeMonitorItem(id) {
        this.monitorItems = this.monitorItems.filter(item => item.id !== id);
        this.renderMonitorItems();
    }

    async writeMonitorValue(id) {
        const item = this.monitorItems.find(i => i.id === id);
        if (!item) {
            console.error('Monitor item not found:', id);
            return;
        }

        const input = document.getElementById(`write-${id}`);
        const value = input.value;

        if (value === '') return;

        console.log('Writing value:', {
            plc: this.currentPLC,
            db: item.dbNumber,
            offset: item.offset,
            type: item.dataType,
            value: value,
            bit: item.bitOffset
        });

        try {
            const success = await window.electronAPI.writeValue(
                this.currentPLC,
                item.dbNumber,
                item.offset,
                item.dataType,
                value,
                item.bitOffset
            );

            console.log('Write result:', success);

            // Always clear input and refresh
            input.value = '';
            await this.refreshMonitor();
        } catch (e) {
            console.error('Write error:', e);
            input.value = '';
            await this.refreshMonitor();
        }
    }


    startMonitor() {
        if (this.monitorInterval) {
            clearInterval(this.monitorInterval);
        }

        this.monitorInterval = setInterval(() => {
            this.refreshMonitor();
        }, 500);
    }

    stopMonitor() {
        if (this.monitorInterval) {
            clearInterval(this.monitorInterval);
            this.monitorInterval = null;
        }
    }

    async refreshMonitor() {
        if (this.monitorItems.length === 0) return;

        try {
            const results = await window.electronAPI.readMultiple(
                this.currentPLC,
                this.monitorItems.map(item => ({
                    dbNumber: item.dbNumber,
                    offset: item.offset,
                    dataType: item.dataType,
                    bitOffset: item.bitOffset
                }))
            );

            console.log('Monitor refresh results:', results);

            results.forEach((result, index) => {
                if (this.monitorItems[index]) {
                    this.monitorItems[index].value = result.value;
                }
            });

            // Update UI
            this.monitorItems.forEach(item => {
                const card = document.querySelector(`.monitor-card[data-id="${item.id}"]`);
                if (card) {
                    const valueEl = card.querySelector('.monitor-card-value');
                    if (valueEl) {
                        const formattedValue = this.formatValue(item.value, item.dataType);
                        valueEl.textContent = formattedValue;
                    }
                }
            });
        } catch (e) {
            console.error('Refresh error:', e);
        }
    }


    // ============ Write Values ============
    bindWriteControls() {
        document.getElementById('btn-add-write-row').addEventListener('click', () => {
            this.addWriteRow();
        });

        document.getElementById('btn-write-all').addEventListener('click', () => {
            this.writeAllValues();
        });
    }

    addWriteRow() {
        const id = Date.now();
        this.writeRows.push(id);

        const container = document.getElementById('write-rows');
        const row = document.createElement('div');
        row.className = 'write-row';
        row.dataset.id = id;
        row.innerHTML = `
      <input type="number" class="input" placeholder="DB" min="1" data-field="db">
      <input type="number" class="input" placeholder="Offset" min="0" data-field="offset">
      <select class="input" data-field="type">
        <option value="BOOL">BOOL</option>
        <option value="BYTE">BYTE</option>
        <option value="WORD">WORD</option>
        <option value="DWORD">DWORD</option>
        <option value="INT" selected>INT</option>
        <option value="DINT">DINT</option>
        <option value="REAL">REAL</option>
        <option value="STRING">STRING</option>
      </select>
      <input type="number" class="input" placeholder="Bit" min="0" max="7" data-field="bit" value="0">
      <input type="text" class="input" placeholder="Value" data-field="value">
      <button class="btn btn-ghost btn-icon" onclick="app.removeWriteRow(${id})">
        <svg class="icon" viewBox="0 0 24 24"><path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
      </button>
    `;

        container.appendChild(row);
    }

    removeWriteRow(id) {
        this.writeRows = this.writeRows.filter(r => r !== id);
        const row = document.querySelector(`.write-row[data-id="${id}"]`);
        if (row) {
            row.remove();
        }
    }

    async writeAllValues() {
        const responseEl = document.getElementById('write-response');
        const rows = document.querySelectorAll('#write-rows .write-row');
        let successCount = 0;
        let errorCount = 0;

        for (const row of rows) {
            const db = parseInt(row.querySelector('[data-field="db"]').value);
            const offset = parseInt(row.querySelector('[data-field="offset"]').value);
            const type = row.querySelector('[data-field="type"]').value;
            const bit = parseInt(row.querySelector('[data-field="bit"]').value) || 0;
            const value = row.querySelector('[data-field="value"]').value;

            if (!db || offset === undefined || offset === '' || !value) continue;

            try {
                const success = await window.electronAPI.writeValue(
                    this.currentPLC,
                    db,
                    offset,
                    type,
                    value,
                    bit
                );

                if (success) {
                    successCount++;
                } else {
                    errorCount++;
                }
            } catch (e) {
                errorCount++;
            }
        }

        if (successCount > 0 && errorCount === 0) {
            responseEl.className = 'write-response success';
            responseEl.textContent = `Successfully wrote ${successCount} value(s) to ${this.currentPLC}`;
        } else if (errorCount > 0) {
            responseEl.className = 'write-response error';
            responseEl.textContent = `${errorCount} error(s), ${successCount} success`;
        }

        // Hide after 3 seconds
        setTimeout(() => {
            responseEl.className = 'write-response';
        }, 3000);
    }

    // ============ PLC Settings ============
    bindPLCSettings() {
        document.getElementById('btn-add-plc').addEventListener('click', () => {
            this.showAddPLCModal();
        });
    }

    async loadPLCList() {
        this.plcList = await window.electronAPI.getAllPLCs();
        this.renderPLCList();
        this.renderSidebarPLCs();

        // Set first PLC as current if exists
        if (this.plcList.length > 0 && !this.plcList.find(p => p.name === this.currentPLC)) {
            this.currentPLC = this.plcList[0].name;
        }
    }

    renderSidebarPLCs() {
        const container = document.querySelector('.plc-selector');
        if (!container) return;

        container.innerHTML = this.plcList.map(plc => `
            <button class="plc-btn ${plc.name === this.currentPLC ? 'active' : ''}" data-plc="${plc.name}">
                <span class="plc-indicator"></span>
                ${plc.name}
                <span style="margin-left:auto;font-size:11px;color:var(--text-muted)">${plc.ip}:${plc.port}</span>
            </button>
        `).join('');

        // Re-bind click events
        container.querySelectorAll('.plc-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                this.selectPLC(btn.dataset.plc);
            });
        });
    }

    renderPLCList() {
        const tbody = document.getElementById('plc-table-body');
        if (!tbody) return;

        if (this.plcList.length === 0) {
            tbody.innerHTML = `
                <tr>
                    <td colspan="5">
                        <div class="empty-state">
                            <div class="empty-state-icon">
                                <svg class="icon" style="width:32px;height:32px" viewBox="0 0 24 24">
                                    <rect x="3" y="3" width="18" height="18" rx="2"/>
                                    <path d="M9 9h6M9 15h6"/>
                                </svg>
                            </div>
                            <div class="empty-state-text">No PLCs configured</div>
                        </div>
                    </td>
                </tr>
            `;
            return;
        }

        tbody.innerHTML = this.plcList.map(plc => `
            <tr data-plc="${plc.name}">
                <td><span class="db-number">${plc.name}</span></td>
                <td><span class="db-size">${plc.ip}</span></td>
                <td><span class="db-size">${plc.port}</span></td>
                <td>${plc.dataBlocks.length} DB(s)</td>
                <td>
                    <div class="action-btns">
                        <button class="btn btn-icon btn-ghost" onclick="app.editPLC('${plc.name}', '${plc.ip}', ${plc.port})" title="Edit">
                            <svg class="icon" viewBox="0 0 24 24"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>
                        </button>
                        <button class="btn btn-icon btn-ghost" onclick="app.deletePLC('${plc.name}')" title="Delete">
                            <svg class="icon" viewBox="0 0 24 24"><path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
                        </button>
                    </div>
                </td>
            </tr>
        `).join('');
    }

    showAddPLCModal() {
        document.getElementById('modal-title').textContent = 'Add PLC';
        document.getElementById('modal-body').innerHTML = `
            <div class="form-group">
                <label>Name</label>
                <input type="text" class="input" id="input-plc-name" placeholder="PLC_3" value="PLC_${this.plcList.length + 1}">
            </div>
            <div class="form-group">
                <label>IP Address</label>
                <input type="text" class="input" id="input-plc-ip" placeholder="127.0.0.1" value="127.0.0.1">
            </div>
            <div class="form-group">
                <label>Port</label>
                <input type="number" class="input" id="input-plc-port" min="1" max="65535" value="1102">
            </div>
        `;

        const confirmBtn = document.getElementById('modal-confirm');
        confirmBtn.onclick = () => this.addPLC();
        this.openModal();
    }

    async addPLC() {
        const name = document.getElementById('input-plc-name').value.trim();
        const ip = document.getElementById('input-plc-ip').value.trim();
        const port = parseInt(document.getElementById('input-plc-port').value);

        if (name && ip && port) {
            const result = await window.electronAPI.createPLC(name, ip, port);
            if (result.success) {
                this.closeModal();
                await this.loadPLCList();
            } else {
                alert('Error: ' + result.error);
            }
        }
    }

    editPLC(name, ip, port) {
        document.getElementById('modal-title').textContent = 'Edit PLC';
        document.getElementById('modal-body').innerHTML = `
            <div class="form-group">
                <label>Name</label>
                <input type="text" class="input" id="input-plc-name" value="${name}">
            </div>
            <div class="form-group">
                <label>IP Address</label>
                <input type="text" class="input" id="input-plc-ip" value="${ip}">
            </div>
            <div class="form-group">
                <label>Port</label>
                <input type="number" class="input" id="input-plc-port" min="1" max="65535" value="${port}">
            </div>
        `;

        const confirmBtn = document.getElementById('modal-confirm');
        confirmBtn.onclick = async () => {
            const newName = document.getElementById('input-plc-name').value.trim();
            const newIp = document.getElementById('input-plc-ip').value.trim();
            const newPort = parseInt(document.getElementById('input-plc-port').value);

            if (newName && newIp && newPort) {
                const result = await window.electronAPI.updatePLC(name, newName, newIp, newPort);
                if (result.success) {
                    if (this.currentPLC === name) {
                        this.currentPLC = newName;
                    }
                    this.closeModal();
                    await this.loadPLCList();
                } else {
                    alert('Error: ' + result.error);
                }
            }
        };
        this.openModal();
    }

    async deletePLC(name) {
        document.getElementById('modal-title').textContent = 'Delete PLC';
        document.getElementById('modal-body').innerHTML = `
            <p style="color: var(--text-secondary); margin-bottom: 16px;">
                Are you sure you want to delete <strong style="color: var(--danger);">${name}</strong>?
            </p>
            <p style="color: var(--text-muted); font-size: 13px;">
                This will also delete all Data Blocks associated with this PLC.
            </p>
        `;

        const confirmBtn = document.getElementById('modal-confirm');
        confirmBtn.className = 'btn btn-danger';
        confirmBtn.textContent = 'Delete';
        confirmBtn.onclick = async () => {
            const result = await window.electronAPI.deletePLC(name);
            if (result.success) {
                if (this.currentPLC === name && this.plcList.length > 1) {
                    this.currentPLC = this.plcList.find(p => p.name !== name)?.name || '';
                }
                this.closeModal();
                confirmBtn.className = 'btn btn-primary';
                confirmBtn.textContent = 'Confirm';
                await this.loadPLCList();
                await this.loadDataBlocks();
            } else {
                alert('Error: ' + result.error);
            }
        };
        this.openModal();
    }
}

// Initialize app
const app = new App();

