class VirtualPlcApp {
    constructor() {
        this.profiles = [];
        this.plcs = [];
        this.currentPLCName = '';
        this.currentTab = 'map';
        this.rowsByPLC = this.loadRows();
        this.mapTypes = this.loadMapTypes();
        this.mapCellState = {};
        this.mapWriteTimers = {};
        this.activeMapAreaCode = '';
        this.mapStartOffset = 0;
        this.mapRenderedEndOffset = 0;
        this.mapVisibleOffsets = new Set();
        this.mapVisibleReadTimer = null;
        this.mapObserver = null;
        this.mapReading = false;
        this.mapReadSequence = 0;
        this.refreshTimer = null;
        this.toastTimer = null;
        this.modalConfirm = null;
        this.switchingPLC = false;
        this.theme = this.loadTheme();

        this.init();
    }

    async init() {
        this.applyTheme();
        this.bindChrome();
        this.bindWorkspace();
        this.bindModal();
        await this.reloadAll();
        this.startRefreshLoop();
        setInterval(() => this.updateServerStatus(), 5000);
    }

    bindChrome() {
        document.getElementById('btn-theme').addEventListener('click', () => this.toggleTheme());
        document.getElementById('btn-minimize').addEventListener('click', () => window.electronAPI.minimize());
        document.getElementById('btn-maximize').addEventListener('click', () => window.electronAPI.maximize());
        document.getElementById('btn-close').addEventListener('click', () => window.electronAPI.close());
        document.getElementById('btn-restart').addEventListener('click', async () => {
            await window.electronAPI.restartServer();
            this.toast('Hub restart requested');
            setTimeout(() => this.reloadAll(), 1200);
        });
    }

    bindWorkspace() {
        document.getElementById('btn-edit-plc').addEventListener('click', () => this.showPLCModal(this.currentPLC()));
        document.getElementById('btn-add-row').addEventListener('click', () => this.addRow());
        document.getElementById('btn-bulk-add').addEventListener('click', () => this.showBulkModal());
        document.getElementById('btn-refresh-now').addEventListener('click', () => this.refreshActiveView());
        document.getElementById('btn-seed-defaults').addEventListener('click', () => this.seedDefaultRows(true));
        document.getElementById('btn-add-db').addEventListener('click', () => this.showDBModal());
        document.getElementById('plc-profile-select').addEventListener('change', (event) => {
            this.switchPLCProfile(event.target.value);
        });

        document.getElementById('auto-refresh').addEventListener('change', (event) => {
            if (event.target.checked) {
                this.startRefreshLoop();
            } else {
                this.stopRefreshLoop();
            }
        });

        document.querySelectorAll('.tab-button').forEach((button) => {
            button.addEventListener('click', () => this.switchTab(button.dataset.tab));
        });

        document.getElementById('memory-map').addEventListener('click', (event) => {
            const area = event.target.closest('[data-map-area]');
            if (area) {
                this.openMapArea(area.dataset.mapArea);
                return;
            }

            const boolToggle = event.target.closest('[data-map-bool]');
            if (boolToggle) {
                this.toggleMapBool(Number(boolToggle.dataset.mapIndex));
                return;
            }

            const action = event.target.closest('[data-map-action]');
            if (!action) return;
            const actionName = action.dataset.mapAction;
            if (actionName === 'back') this.closeMapArea();
            if (actionName === 'refresh') this.refreshMapPage();
        });

        document.getElementById('memory-map').addEventListener('change', (event) => {
            if (event.target.matches('[data-map-start-address]')) {
                this.changeMapStartAddress(event.target.value);
                return;
            }
            if (event.target.matches('[data-map-type]')) {
                this.changeMapCellType(Number(event.target.dataset.mapIndex), event.target.value);
            }
        });

        document.getElementById('memory-map').addEventListener('input', (event) => {
            if (!event.target.matches('[data-map-value]')) return;
            const index = Number(event.target.dataset.mapIndex);
            const state = this.mapCellState[index] || {};
            state.value = event.target.value;
            this.mapCellState[index] = state;
            this.queueMapCellWrite(index);
        });

        document.getElementById('memory-map').addEventListener('focusout', (event) => {
            if (event.target.matches('[data-map-start-address]')) {
                this.changeMapStartAddress(event.target.value);
                return;
            }
            if (!event.target.matches('[data-map-value]')) return;
            this.writeMapCell(Number(event.target.dataset.mapIndex));
        });

        document.getElementById('memory-map').addEventListener('keydown', (event) => {
            if (event.key === 'Enter' && event.target.matches('[data-map-start-address]')) {
                event.preventDefault();
                event.target.blur();
                this.changeMapStartAddress(event.target.value);
                return;
            }
            if (event.key !== 'Enter' || !event.target.matches('[data-map-value]')) return;
            event.preventDefault();
            this.writeMapCell(Number(event.target.dataset.mapIndex));
        });

        document.getElementById('tab-map').addEventListener('scroll', () => this.handleMapScroll());

        document.getElementById('watch-body').addEventListener('input', (event) => {
            const field = event.target.dataset.field;
            const rowId = event.target.dataset.row;
            if (!field || !rowId) return;
            this.updateRow(rowId, { [field]: event.target.value });
        });

        document.getElementById('watch-body').addEventListener('change', (event) => {
            const field = event.target.dataset.field;
            const rowId = event.target.dataset.row;
            if (!field || !rowId) return;
            this.updateRow(rowId, { [field]: event.target.value });
            if (field === 'dataType') {
                this.renderRows();
            }
            if (field === 'address' || field === 'dataType') {
                this.refreshRows();
            }
        });

        document.getElementById('watch-body').addEventListener('keydown', (event) => {
            if (event.key !== 'Enter') return;
            const rowId = event.target.dataset.row;
            if (rowId && event.target.dataset.field === 'value') {
                event.preventDefault();
                this.writeRow(rowId);
            }
        });

        document.getElementById('watch-body').addEventListener('click', (event) => {
            const action = event.target.closest('[data-action]');
            if (!action) return;
            const rowId = action.dataset.row;
            if (action.dataset.action === 'write') this.writeRow(rowId);
            if (action.dataset.action === 'delete') this.deleteRow(rowId);
            if (action.dataset.action === 'duplicate') this.duplicateRow(rowId);
        });

        document.getElementById('db-body').addEventListener('click', (event) => {
            const action = event.target.closest('[data-db-action]');
            if (!action) return;
            const dbNumber = Number(action.dataset.db);
            if (action.dataset.dbAction === 'delete') this.deleteDB(dbNumber);
            if (action.dataset.dbAction === 'edit') this.showDBModal(dbNumber, Number(action.dataset.size));
        });
    }

    bindModal() {
        document.getElementById('modal-close').addEventListener('click', () => this.closeModal());
        document.getElementById('modal-cancel').addEventListener('click', () => this.closeModal());
        document.getElementById('modal-overlay').addEventListener('click', (event) => {
            if (event.target.id === 'modal-overlay') this.closeModal();
        });
        document.getElementById('modal-confirm').addEventListener('click', () => {
            if (this.modalConfirm) this.modalConfirm();
        });
    }

    async reloadAll() {
        await this.updateServerStatus();
        this.profiles = await window.electronAPI.getProfiles();
        this.plcs = await window.electronAPI.getAllPLCs();
        if (!this.currentPLCName && this.plcs.length > 0) {
            this.currentPLCName = this.plcs[0].name;
        }
        if (this.currentPLCName && !this.plcs.find((plc) => plc.name === this.currentPLCName)) {
            this.currentPLCName = this.plcs[0]?.name || '';
        }
        this.seedDefaultRows(false);
        if (!this.currentPLC()?.areas?.some((area) => area.code === this.activeMapAreaCode)) {
            this.activeMapAreaCode = '';
            this.mapStartOffset = 0;
        }
        this.render();
        await this.refreshRows();
        if (this.currentTab === 'map' && this.activeMapAreaCode) {
            await this.refreshMapPage();
        }
    }

    async updateServerStatus() {
        const dot = document.getElementById('server-dot');
        const text = document.getElementById('server-text');
        const title = document.getElementById('titlebar-status');
        const status = await window.electronAPI.getServerStatus();
        dot.classList.toggle('online', Boolean(status.connected));
        text.textContent = status.connected ? `${status.plcs || 0} PLC active` : 'Hub offline';
        title.textContent = status.connected ? 'Hub online' : 'Hub offline';
    }

    render() {
        this.renderPLCSelector();
        this.renderActiveHeader();
        this.renderTabs();
        this.renderRows();
        this.renderMemoryMap();
        this.renderInspector();
        this.renderDataBlocks();
    }

    renderPLCSelector() {
        const select = document.getElementById('plc-profile-select');
        const plc = this.currentPLC();
        const activeProfileId = plc?.profileId || '';
        const placeholder = plc ? '' : '<option value="" selected disabled>Select PLC profile</option>';
        select.innerHTML = placeholder + this.profiles.map((profile) => `
            <option value="${profile.id}" ${profile.id === activeProfileId ? 'selected' : ''}>${this.escape(profile.name)}</option>
        `).join('');
        select.disabled = this.switchingPLC || !this.profiles.length;

        const isActive = Boolean(plc && plc.status !== 'stopped');
        document.getElementById('station-dot').classList.toggle('online', isActive);
        document.getElementById('station-name').textContent = plc?.name || 'No PLC active';
        document.getElementById('station-status').textContent = plc?.status || 'Stopped';
        document.getElementById('station-kind').textContent = plc?.profileName || '--';
        document.getElementById('station-endpoint').textContent = plc ? `${plc.host || plc.ip}:${plc.port}` : '--';
    }

    renderActiveHeader() {
        const plc = this.currentPLC();
        document.getElementById('active-plc-name').textContent = plc?.name || 'No PLC';
        document.getElementById('active-profile').textContent = plc?.profileName || 'Profile';
        document.getElementById('active-endpoint').textContent = plc ? `${plc.protocol} | ${plc.host || plc.ip}:${plc.port}` : '--';
    }

    renderTabs() {
        const dbTab = document.querySelector('[data-tab="dbs"]');
        const dbPanel = document.getElementById('tab-dbs');
        const canUseDataBlocks = this.canUseDataBlocks();

        dbTab.hidden = !canUseDataBlocks;
        dbPanel.hidden = !canUseDataBlocks;
        if (!canUseDataBlocks && this.currentTab === 'dbs') {
            this.currentTab = 'map';
        }

        document.querySelectorAll('.tab-button').forEach((button) => {
            button.classList.toggle('active', button.dataset.tab === this.currentTab);
        });
        document.querySelectorAll('.tab-panel').forEach((panel) => {
            panel.classList.toggle('active', panel.id === `tab-${this.currentTab}`);
        });
        this.renderToolbar();
    }

    renderToolbar() {
        const onRegisters = this.currentTab === 'registers';
        document.getElementById('btn-add-row').hidden = !onRegisters;
        document.getElementById('btn-bulk-add').hidden = !onRegisters;
        document.getElementById('btn-refresh-now').hidden = true;
    }

    renderRows() {
        const body = document.getElementById('watch-body');
        const rows = this.currentRows();
        const plc = this.currentPLC();
        const profile = this.profileFor(plc);
        const types = profile?.dataTypes?.length ? profile.dataTypes : ['Bool', 'Int16', 'UInt16', 'Int32', 'UInt32', 'Float'];

        if (!rows.length) {
            body.innerHTML = '<tr><td colspan="7"><div class="empty-state">No register rows</div></td></tr>';
            return;
        }

        body.innerHTML = rows.map((row) => {
            const valueInputAttributes = this.valueInputAttributes(row.dataType);
            return `
                <tr data-row="${row.id}">
                    <td><input class="cell-input" data-row="${row.id}" data-field="tagName" value="${this.escape(row.tagName)}"></td>
                    <td><input class="cell-input mono" data-row="${row.id}" data-field="address" value="${this.escape(row.address)}" placeholder="${this.escape(this.firstExample())}"></td>
                    <td>
                        <select class="cell-select" data-row="${row.id}" data-field="dataType">
                            ${types.map((type) => `<option value="${type}" ${type === row.dataType ? 'selected' : ''}>${type}</option>`).join('')}
                        </select>
                    </td>
                    <td><input class="cell-input mono" ${valueInputAttributes} data-row="${row.id}" data-field="value" value="${this.escape(row.value ?? '')}"></td>
                    <td><span class="${this.qualityClass(row.quality)}">${this.escape(row.quality || 'N/A')}</span></td>
                    <td><span class="mono">${this.escape(row.updatedAt || '--')}</span></td>
                    <td>
                        <div class="row-actions">
                            <button class="icon-button" data-action="write" data-row="${row.id}" title="Write" aria-label="Write">
                                <svg class="icon" viewBox="0 0 24 24"><path d="M5 12h14" /><path d="M13 5l7 7-7 7" /></svg>
                            </button>
                            <button class="icon-button" data-action="duplicate" data-row="${row.id}" title="Duplicate" aria-label="Duplicate">
                                <svg class="icon" viewBox="0 0 24 24"><rect x="8" y="8" width="11" height="11" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v1" /></svg>
                            </button>
                            <button class="icon-button" data-action="delete" data-row="${row.id}" title="Delete" aria-label="Delete">
                                <svg class="icon" viewBox="0 0 24 24"><path d="M3 6h18" /><path d="M8 6V4h8v2" /><path d="M19 6l-1 14H6L5 6" /></svg>
                            </button>
                        </div>
                    </td>
                </tr>
            `;
        }).join('');
    }

    renderMemoryMap() {
        const map = document.getElementById('memory-map');
        const plc = this.currentPLC();
        if (!plc?.areas?.length) {
            this.destroyMapObserver();
            map.innerHTML = '<div class="empty-state">No memory map</div>';
            return;
        }

        const activeArea = plc.areas.find((area) => area.code === this.activeMapAreaCode);
        if (activeArea) {
            this.renderMapDetail(activeArea);
            return;
        }

        this.destroyMapObserver();
        map.innerHTML = plc.areas.map((area) => `
            <button class="area-tile" data-map-area="${this.escape(area.code)}" type="button">
                <div class="area-head">
                    <span class="area-code">${this.escape(area.code)}</span>
                    <span class="area-open">
                        <span class="area-kind">${this.escape(area.kind)}</span>
                        <svg class="icon" viewBox="0 0 24 24"><path d="M9 18l6-6-6-6" /></svg>
                    </span>
                </div>
                <div class="area-name">${this.escape(area.name)}</div>
                <div class="area-range">${this.escape(area.range)}</div>
            </button>
        `).join('');
    }

    renderMapDetail(area) {
        const map = document.getElementById('memory-map');
        const range = this.parseMapRange(area);
        if (!range) {
            this.destroyMapObserver();
            map.innerHTML = '<div class="empty-state">Unsupported memory range</div>';
            return;
        }

        this.destroyMapObserver();
        const startOffset = Math.min(Math.max(this.mapStartOffset, 0), range.count - 1);
        this.mapStartOffset = startOffset;
        const endOffset = Math.min(startOffset + this.mapInitialRenderCount(area), range.count);
        this.mapRenderedEndOffset = endOffset;
        const cells = [];

        for (let offset = startOffset; offset < endOffset; offset += 1) {
            cells.push(this.renderMapCell(area, range, offset));
        }

        map.innerHTML = `
            <div class="map-detail">
                <div class="map-sticky-head">
                    <div class="map-detail-toolbar">
                        <div class="map-detail-identity">
                            <button class="icon-button" data-map-action="back" type="button" title="Back to memory areas" aria-label="Back to memory areas">
                                <svg class="icon" viewBox="0 0 24 24"><path d="M19 12H5" /><path d="M11 18l-6-6 6-6" /></svg>
                            </button>
                            <div>
                                <div class="map-detail-title">
                                    <span class="area-code">${this.escape(area.code)}</span>
                                    <strong>${this.escape(area.name)}</strong>
                                </div>
                                <div class="map-detail-range">${this.escape(area.range)} | ${range.count.toLocaleString()} addresses</div>
                            </div>
                        </div>
                        <div class="map-detail-controls">
                            <div class="map-start-controls">
                                <label class="map-start-label">
                                    <span>Start</span>
                                    <input class="map-start-input mono" data-map-start-address value="${this.escape(this.formatMapAddress(range, startOffset))}" aria-label="Start address">
                                </label>
                                <button class="icon-button strong" data-map-action="refresh" type="button" title="Read visible addresses" aria-label="Read visible addresses">
                                    <svg class="icon" viewBox="0 0 24 24"><path d="M21 12a9 9 0 1 1-2.64-6.36" /><path d="M21 3v7h-7" /></svg>
                                </button>
                            </div>
                        </div>
                    </div>
                    <div class="map-visible-range">
                        Showing ${this.escape(this.formatMapAddress(range, startOffset))}-${this.escape(this.formatMapAddress(range, range.count - 1))}
                        <span class="map-loaded-range" data-map-loaded-range>
                            Loaded ${this.escape(this.formatMapAddress(range, startOffset))}-${this.escape(this.formatMapAddress(range, endOffset - 1))}
                        </span>
                    </div>
                </div>
                <div class="map-register-scroll">
                    <div class="map-register-grid ${area.kind === 'bit' ? 'bit-grid' : ''}">
                        ${cells.join('')}
                    </div>
                </div>
            </div>
        `;
        this.observeVisibleMapCells();
    }

    renderMapCell(area, range, offset) {
        const displayAddress = this.formatMapAddress(range, offset);
        const dataType = this.mapDataType(area, displayAddress);
        const state = this.mapCellState[offset] || {};
        const types = this.mapDataTypes(area);
        const quality = state.quality || 'N/A';
        if (area.kind === 'bit') {
            const active = this.boolValue(state.value);
            return `
                <button class="map-bit-cell ${active ? 'active' : ''}" data-map-cell="${offset}" data-map-bool data-map-index="${offset}" type="button" aria-pressed="${active}" title="${this.escape(displayAddress)} ${active ? 'true' : 'false'}">
                    <span class="map-bit-address">${this.escape(displayAddress)}</span>
                    <span class="map-bit-led ${this.qualityClass(quality)}" data-map-quality="${offset}" title="${this.escape(quality)}"></span>
                </button>
            `;
        }

        const typeControl = types.length === 1
            ? `<span class="map-register-type-fixed">${this.escape(types[0])}</span>`
            : `
                <select class="map-register-type" data-map-type data-map-index="${offset}" aria-label="Data type for ${this.escape(displayAddress)}">
                    ${types.map((type) => `<option value="${type}" ${type === dataType ? 'selected' : ''}>${type}</option>`).join('')}
                </select>
            `;
        const valueControl = dataType === 'Bool'
            ? `
                <button class="map-bool-toggle ${this.boolValue(state.value) ? 'active' : ''}" data-map-bool data-map-index="${offset}" type="button" aria-pressed="${this.boolValue(state.value)}">
                    ${this.boolValue(state.value) ? 'true' : 'false'}
                </button>
            `
            : `<input class="map-register-value mono" ${this.valueInputAttributes(dataType)} data-map-value data-map-index="${offset}" value="${this.escape(state.value ?? '')}" aria-label="Value for ${this.escape(displayAddress)}">`;

        return `
            <div class="map-register" data-map-cell="${offset}">
                <div class="map-register-head">
                    <span class="map-register-address">${this.escape(displayAddress)}</span>
                    <span class="map-quality ${this.qualityClass(quality)}" data-map-quality="${offset}" title="${this.escape(quality)}"></span>
                </div>
                ${typeControl}
                <div class="map-register-value-row">
                    ${valueControl}
                </div>
            </div>
        `;
    }

    async renderDataBlocks() {
        const body = document.getElementById('db-body');
        const addButton = document.getElementById('btn-add-db');
        const plc = this.currentPLC();
        addButton.disabled = !this.canUseDataBlocks();
        if (!this.canUseDataBlocks()) {
            body.innerHTML = '';
            return;
        }
        if (!plc) {
            body.innerHTML = '<tr><td colspan="3"><div class="empty-state">No PLC selected</div></td></tr>';
            return;
        }

        const dbs = await window.electronAPI.getDataBlocks(plc.name);
        if (!dbs.length) {
            body.innerHTML = '<tr><td colspan="3"><div class="empty-state">No data blocks</div></td></tr>';
            return;
        }

        body.innerHTML = dbs.map((db) => `
            <tr>
                <td><span class="mono">DB${db.dbNumber}</span></td>
                <td><span class="mono">${db.size}</span></td>
                <td>
                    <div class="row-actions">
                        <button class="icon-button" data-db-action="edit" data-db="${db.dbNumber}" data-size="${db.size}" title="Edit DB" aria-label="Edit DB">
                            <svg class="icon" viewBox="0 0 24 24"><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" /></svg>
                        </button>
                        <button class="icon-button" data-db-action="delete" data-db="${db.dbNumber}" title="Delete DB" aria-label="Delete DB">
                            <svg class="icon" viewBox="0 0 24 24"><path d="M3 6h18" /><path d="M8 6V4h8v2" /><path d="M19 6l-1 14H6L5 6" /></svg>
                        </button>
                    </div>
                </td>
            </tr>
        `).join('');
    }

    renderInspector() {
        const plc = this.currentPLC();
        const examples = document.getElementById('example-list');
        document.getElementById('inspector-profile').textContent = plc?.profileName || '--';
        document.getElementById('inspector-protocol').textContent = plc?.protocol || '--';
        document.getElementById('inspector-status').textContent = plc?.protocolMessage || plc?.status || '--';
        document.getElementById('inspector-endpoint').textContent = plc ? `${plc.host || plc.ip}:${plc.port}` : '--';

        const chips = plc?.addressExamples || [];
        examples.innerHTML = chips.map((example) => `<span class="example-chip">${this.escape(example)}</span>`).join('');
    }

    switchTab(tab) {
        if (tab === 'dbs' && !this.canUseDataBlocks()) {
            tab = 'map';
        }
        this.currentTab = tab;
        this.renderTabs();
        if (tab === 'dbs') this.renderDataBlocks();
        if (tab === 'map' && this.activeMapAreaCode) this.refreshMapPage();
    }

    canUseDataBlocks() {
        return this.currentPLC()?.serverKind === 'snap7';
    }

    async openMapArea(areaCode) {
        this.cancelMapRead();
        this.clearMapWriteTimers();
        this.activeMapAreaCode = areaCode;
        this.mapStartOffset = 0;
        this.mapRenderedEndOffset = 0;
        this.mapCellState = {};
        this.renderMemoryMap();
        await this.refreshMapPage();
    }

    closeMapArea() {
        this.cancelMapRead();
        this.clearMapWriteTimers();
        this.destroyMapObserver();
        this.activeMapAreaCode = '';
        this.mapStartOffset = 0;
        this.mapRenderedEndOffset = 0;
        this.mapCellState = {};
        this.renderMemoryMap();
    }

    changeMapStartAddress(address) {
        const area = this.currentMapArea();
        const range = area ? this.parseMapRange(area) : null;
        if (!range) return;
        const nextOffset = this.parseMapStartOffset(address, range);
        if (nextOffset === null) {
            this.renderMemoryMap();
            this.toast('Invalid start address', true);
            return;
        }
        if (nextOffset === this.mapStartOffset) return;
        this.cancelMapRead();
        this.clearMapWriteTimers();
        this.mapStartOffset = nextOffset;
        this.mapRenderedEndOffset = 0;
        this.mapCellState = {};
        this.renderMemoryMap();
        this.refreshMapPage();
    }

    mapInitialRenderCount(area) {
        return area?.kind === 'bit' ? 1200 : 900;
    }

    mapAppendCount(area) {
        return area?.kind === 'bit' ? 800 : 600;
    }

    handleMapScroll() {
        if (this.currentTab !== 'map' || !this.activeMapAreaCode) return;
        const panel = document.getElementById('tab-map');
        if (!panel) return;
        if (panel.scrollTop + panel.clientHeight >= panel.scrollHeight - 700) {
            this.appendMapCells();
        }
        this.queueVisibleMapRead();
    }

    appendMapCells() {
        const area = this.currentMapArea();
        const range = area ? this.parseMapRange(area) : null;
        const grid = document.querySelector('#memory-map .map-register-grid');
        if (!area || !range || !grid || this.mapRenderedEndOffset >= range.count) return;

        const startOffset = this.mapRenderedEndOffset;
        const endOffset = Math.min(startOffset + this.mapAppendCount(area), range.count);
        const cells = [];
        for (let offset = startOffset; offset < endOffset; offset += 1) {
            cells.push(this.renderMapCell(area, range, offset));
        }
        grid.insertAdjacentHTML('beforeend', cells.join(''));
        this.mapRenderedEndOffset = endOffset;
        const loaded = document.querySelector('[data-map-loaded-range]');
        if (loaded) {
            loaded.textContent = `Loaded ${this.formatMapAddress(range, this.mapStartOffset)}-${this.formatMapAddress(range, endOffset - 1)}`;
        }
        if (this.mapObserver) {
            for (let offset = startOffset; offset < endOffset; offset += 1) {
                const cell = document.querySelector(`[data-map-cell="${offset}"]`);
                if (cell) this.mapObserver.observe(cell);
            }
        }
    }

    parseMapStartOffset(address, range) {
        const text = String(address || '').trim().toUpperCase();
        if (!text) return null;
        const prefix = range.prefix.toUpperCase();
        const rawNumber = prefix && text.startsWith(prefix) ? text.slice(prefix.length) : text;
        if (!rawNumber || !/^[0-9A-F]+$/i.test(rawNumber)) return null;
        const value = parseInt(rawNumber, range.base);
        if (!Number.isFinite(value)) return null;
        return Math.min(Math.max(value - range.start, 0), range.count - 1);
    }

    changeMapCellType(offset, dataType) {
        const area = this.currentMapArea();
        const range = area ? this.parseMapRange(area) : null;
        if (!area || !range) return;
        this.cancelMapRead();
        const displayAddress = this.formatMapAddress(range, offset);
        this.mapTypes[this.mapTypeKey(area, displayAddress)] = dataType;
        this.saveMapTypes();
        this.mapCellState[offset] = { value: '', quality: 'N/A' };
        const cell = document.querySelector(`[data-map-cell="${offset}"]`);
        if (cell) {
            cell.outerHTML = this.renderMapCell(area, range, offset);
            const nextCell = document.querySelector(`[data-map-cell="${offset}"]`);
            if (nextCell && this.mapObserver) this.mapObserver.observe(nextCell);
        } else {
            this.renderMemoryMap();
        }
        this.refreshMapCells([offset]);
    }

    destroyMapObserver() {
        if (this.mapObserver) {
            this.mapObserver.disconnect();
            this.mapObserver = null;
        }
        this.mapVisibleOffsets.clear();
        clearTimeout(this.mapVisibleReadTimer);
        this.mapVisibleReadTimer = null;
    }

    observeVisibleMapCells() {
        this.destroyMapObserver();
        const root = document.getElementById('tab-map');
        const cells = document.querySelectorAll('#memory-map [data-map-cell]');
        if (!cells.length) return;

        this.mapObserver = new IntersectionObserver((entries) => {
            let shouldRead = false;
            entries.forEach((entry) => {
                const offset = Number(entry.target.dataset.mapCell);
                if (!Number.isFinite(offset)) return;
                if (entry.isIntersecting) {
                    this.mapVisibleOffsets.add(offset);
                    shouldRead = true;
                } else {
                    this.mapVisibleOffsets.delete(offset);
                }
            });
            if (shouldRead) this.queueVisibleMapRead();
        }, {
            root,
            rootMargin: '120px 0px',
            threshold: 0.01
        });

        cells.forEach((cell) => this.mapObserver.observe(cell));
    }

    queueVisibleMapRead() {
        clearTimeout(this.mapVisibleReadTimer);
        this.mapVisibleReadTimer = setTimeout(() => {
            this.mapVisibleReadTimer = null;
            this.refreshVisibleMapCells();
        }, 80);
    }

    queueMapCellWrite(offset) {
        clearTimeout(this.mapWriteTimers[offset]);
        this.mapWriteTimers[offset] = setTimeout(() => {
            delete this.mapWriteTimers[offset];
            this.writeMapCell(offset);
        }, 650);
    }

    clearMapWriteTimers() {
        Object.values(this.mapWriteTimers).forEach((timer) => clearTimeout(timer));
        this.mapWriteTimers = {};
    }

    async toggleMapBool(offset) {
        const state = this.mapCellState[offset] || {};
        state.value = String(!this.boolValue(state.value));
        this.mapCellState[offset] = state;
        this.patchMapCell(offset);
        await this.writeMapCell(offset);
    }

    async refreshActiveView() {
        if (this.currentTab === 'map') {
            if (this.activeMapAreaCode) {
                await this.refreshMapPage();
            }
            return;
        }
        if (this.currentTab !== 'registers') return;
        await this.refreshRows();
    }

    async refreshMapPage() {
        await this.refreshVisibleMapCells();
    }

    async refreshVisibleMapCells() {
        const area = this.currentMapArea();
        const range = area ? this.parseMapRange(area) : null;
        if (!area || !range || this.mapReading || this.switchingPLC) return;
        const observedOffsets = Array.from(this.mapVisibleOffsets)
            .filter((offset) => document.querySelector(`[data-map-cell="${offset}"]`));
        const offsets = (observedOffsets.length ? observedOffsets : this.findVisibleMapOffsets())
            .sort((a, b) => a - b)
            .slice(0, 260);
        if (!offsets.length) return;
        await this.refreshMapCells(offsets);
    }

    findVisibleMapOffsets() {
        const root = document.getElementById('tab-map');
        if (!root) return [];
        const rootBox = root.getBoundingClientRect();
        const offsets = [];
        document.querySelectorAll('#memory-map [data-map-cell]').forEach((cell) => {
            const box = cell.getBoundingClientRect();
            const visible = box.bottom >= rootBox.top - 120
                && box.top <= rootBox.bottom + 120
                && box.right >= rootBox.left
                && box.left <= rootBox.right;
            if (visible) offsets.push(Number(cell.dataset.mapCell));
        });
        return offsets.filter(Number.isFinite);
    }

    async refreshMapCells(offsets) {
        const plc = this.currentPLC();
        const area = this.currentMapArea();
        const range = area ? this.parseMapRange(area) : null;
        if (!plc || !area || !range || !offsets.length) return;

        const sequence = ++this.mapReadSequence;
        this.mapReading = true;
        try {
            const requests = offsets.map((offset) => {
                const displayAddress = this.formatMapAddress(range, offset);
                const dataType = this.mapDataType(area, displayAddress);
                return {
                    id: String(offset),
                    address: this.mapApiAddress(area, range, offset, dataType),
                    type: dataType
                };
            });
            const results = await window.electronAPI.readMultiple(plc.name, requests);
            if (sequence !== this.mapReadSequence) return;

            results.forEach((result) => {
                const offset = Number(result.id);
                const state = this.mapCellState[offset] || {};
                state.quality = result.quality || (result.error ? 'Bad' : 'Good');
                if (!result.error) state.value = this.formatValue(result.value);
                this.mapCellState[offset] = state;
                this.patchMapCell(offset);
            });
        } catch (error) {
            if (sequence === this.mapReadSequence) {
                this.toast(error.message || 'Map read failed', true);
            }
        } finally {
            if (sequence === this.mapReadSequence) this.mapReading = false;
        }
    }

    cancelMapRead() {
        this.mapReadSequence += 1;
        this.mapReading = false;
    }

    async writeMapCell(offset) {
        clearTimeout(this.mapWriteTimers[offset]);
        delete this.mapWriteTimers[offset];

        const plc = this.currentPLC();
        const area = this.currentMapArea();
        const range = area ? this.parseMapRange(area) : null;
        if (!plc || !area || !range) return;

        const displayAddress = this.formatMapAddress(range, offset);
        const dataType = this.mapDataType(area, displayAddress);
        const input = document.querySelector(`[data-map-value][data-map-index="${offset}"]`);
        const boolToggle = document.querySelector(`[data-map-bool][data-map-index="${offset}"]`);
        const value = input?.value ?? boolToggle?.getAttribute('aria-pressed') ?? this.mapCellState[offset]?.value ?? '';
        const result = await window.electronAPI.writeValue({
            plc: plc.name,
            address: this.mapApiAddress(area, range, offset, dataType),
            type: dataType,
            value
        });

        const state = this.mapCellState[offset] || {};
        if (result?.success) {
            state.value = this.formatValue(result.value ?? value);
            state.quality = result.quality || 'Good';
            this.toast(`Wrote ${displayAddress}`);
        } else {
            state.quality = 'Bad';
            this.toast(result?.error || `Write ${displayAddress} failed`, true);
        }
        this.mapCellState[offset] = state;
        this.patchMapCell(offset);
    }

    patchMapCell(offset) {
        const state = this.mapCellState[offset] || {};
        const input = document.querySelector(`[data-map-value][data-map-index="${offset}"]`);
        if (input && document.activeElement !== input && !this.mapWriteTimers[offset]) input.value = state.value ?? '';
        const boolToggle = document.querySelector(`[data-map-bool][data-map-index="${offset}"]`);
        if (boolToggle) {
            const active = this.boolValue(state.value);
            boolToggle.classList.toggle('active', active);
            boolToggle.setAttribute('aria-pressed', String(active));
            boolToggle.title = `${this.currentMapCellAddress(offset)} ${active ? 'true' : 'false'}`;
            if (boolToggle.classList.contains('map-bool-toggle')) {
                boolToggle.textContent = active ? 'true' : 'false';
            }
        }
        const quality = document.querySelector(`[data-map-quality="${offset}"]`);
        if (quality) {
            const qualityBase = quality.classList.contains('map-bit-led') ? 'map-bit-led' : 'map-quality';
            quality.className = `${qualityBase} ${this.qualityClass(state.quality)}`;
            quality.title = state.quality || 'N/A';
        }
    }

    boolValue(value) {
        if (value === true) return true;
        if (value === false || value === null || value === undefined) return false;
        return String(value).trim().toLowerCase() === 'true' || String(value).trim() === '1';
    }

    currentMapCellAddress(offset) {
        const area = this.currentMapArea();
        const range = area ? this.parseMapRange(area) : null;
        return range ? this.formatMapAddress(range, offset) : '';
    }

    currentMapArea() {
        return this.currentPLC()?.areas?.find((area) => area.code === this.activeMapAreaCode) || null;
    }

    parseMapRange(area) {
        const match = String(area.range || '').match(/^([A-Z]*)([0-9A-F]+)-([A-Z]*)([0-9A-F]+)$/i);
        if (!match) return null;

        const plc = this.currentPLC();
        const prefix = match[1] || '';
        const endPrefix = match[3] || prefix;
        if (prefix !== endPrefix) return null;

        let base = 10;
        if (plc?.profileId === 'mitsubishi-q' && ['X', 'Y', 'B', 'W'].includes(area.code)) base = 16;
        if (['mitsubishi-fx3u', 'delta-dvp'].includes(plc?.profileId) && ['X', 'Y'].includes(area.code)) base = 8;

        const start = parseInt(match[2], base);
        const end = parseInt(match[4], base);
        if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;

        return {
            base,
            prefix,
            start,
            end,
            count: end - start + 1,
            pad: match[2].startsWith('0') ? match[2].length : 0
        };
    }

    formatMapAddress(range, offset) {
        const value = range.start + offset;
        const number = value.toString(range.base).toUpperCase().padStart(range.pad, '0');
        return `${range.prefix}${number}`;
    }

    mapDataTypes(area) {
        const profile = this.profileFor(this.currentPLC());
        const types = profile?.dataTypes?.length ? profile.dataTypes : ['Bool', 'Int16', 'UInt16', 'Int32', 'UInt32', 'Float'];
        if (area.kind === 'bit') return ['Bool'];
        if (this.currentPLC()?.profileId === 'siemens-s7') return types;
        return types.filter((type) => type !== 'Bool');
    }

    mapDataType(area, displayAddress) {
        const allowed = this.mapDataTypes(area);
        const saved = this.mapTypes[this.mapTypeKey(area, displayAddress)];
        if (allowed.includes(saved)) return saved;
        if (area.kind === 'bit') return 'Bool';
        if (area.kind === 'byte' && allowed.includes('Byte')) return 'Byte';
        if (allowed.includes('UInt16')) return 'UInt16';
        if (allowed.includes('Int16')) return 'Int16';
        return allowed[0];
    }

    mapTypeKey(area, displayAddress) {
        return `${this.currentPLC()?.profileId || 'plc'}:${area.code}:${displayAddress}`;
    }

    mapApiAddress(area, range, offset, dataType) {
        const displayAddress = this.formatMapAddress(range, offset);
        if (this.currentPLC()?.profileId !== 'siemens-s7') return displayAddress;

        const numericOffset = range.start + offset;
        if (area.code === 'DB') {
            if (dataType === 'Bool') return `DB${numericOffset}.DBX0.0`;
            if (dataType === 'Byte' || dataType === 'String') return `DB${numericOffset}.DBB0`;
            if (['Int16', 'UInt16'].includes(dataType)) return `DB${numericOffset}.DBW0`;
            return `DB${numericOffset}.DBD0`;
        }

        if (dataType === 'Bool') return `${area.code}${numericOffset}.0`;
        if (dataType === 'Byte' || dataType === 'String') return `${area.code}B${numericOffset}`;
        if (['Int16', 'UInt16'].includes(dataType)) return `${area.code}W${numericOffset}`;
        return `${area.code}D${numericOffset}`;
    }

    async switchPLCProfile(profileId) {
        const profile = this.profiles.find((item) => item.id === profileId);
        const current = this.currentPLC();
        if (!profile || this.switchingPLC || current?.profileId === profileId) return;

        this.cancelMapRead();
        this.switchingPLC = true;
        this.renderPLCSelector();
        const payload = {
            profileId: profile.id,
            name: this.defaultPLCName(profile),
            host: profile.defaultHost,
            port: profile.defaultPort,
            unitId: profile.serverKind === 'modbus' ? 1 : null
        };

        const result = current
            ? await window.electronAPI.updatePLC(current.name, payload)
            : await window.electronAPI.createPLC(payload);

        if (result?.success) {
            this.currentPLCName = result.plc.name;
            await this.reloadAll();
            this.toast(`${profile.name} active`);
        } else {
            this.toast(result?.error || 'PLC switch failed', true);
        }

        this.switchingPLC = false;
        this.renderPLCSelector();
    }

    currentPLC() {
        return this.plcs.find((plc) => plc.name === this.currentPLCName);
    }

    profileFor(plc) {
        if (!plc) return null;
        return this.profiles.find((profile) => profile.id === plc.profileId || profile.id === plc.type);
    }

    currentRows() {
        if (!this.currentPLCName) return [];
        if (!this.rowsByPLC[this.currentPLCName]) {
            this.rowsByPLC[this.currentPLCName] = [];
        }
        return this.rowsByPLC[this.currentPLCName];
    }

    seedDefaultRows(force) {
        const plc = this.currentPLC();
        if (!plc || !this.currentPLCName) return;
        const rows = this.currentRows();
        if (rows.length && !force) return;
        if (force) rows.splice(0, rows.length);

        const defaults = plc.defaultRegisters?.length ? plc.defaultRegisters : [];
        defaults.forEach((item) => {
            rows.push(this.createRow(item.tagName, item.address, item.dataType));
        });
        this.saveRows();
        this.renderRows();
    }

    addRow(seed = {}) {
        const rows = this.currentRows();
        rows.push(this.createRow(
            seed.tagName || `Tag ${rows.length + 1}`,
            seed.address || this.firstExample(),
            seed.dataType || this.defaultDataType()
        ));
        this.saveRows();
        this.renderRows();
    }

    duplicateRow(rowId) {
        const rows = this.currentRows();
        const row = rows.find((item) => item.id === rowId);
        if (!row) return;
        rows.push(this.createRow(`${row.tagName} Copy`, this.incrementAddress(row.address, row.dataType), row.dataType));
        this.saveRows();
        this.renderRows();
    }

    deleteRow(rowId) {
        this.rowsByPLC[this.currentPLCName] = this.currentRows().filter((row) => row.id !== rowId);
        this.saveRows();
        this.renderRows();
    }

    updateRow(rowId, patch) {
        const row = this.currentRows().find((item) => item.id === rowId);
        if (!row) return;
        Object.assign(row, patch);
        this.saveRows();
    }

    createRow(tagName, address, dataType) {
        return {
            id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
            tagName,
            address,
            dataType,
            value: '',
            quality: 'N/A',
            updatedAt: '--'
        };
    }

    firstExample() {
        const plc = this.currentPLC();
        return plc?.addressExamples?.[0] || 'HR1';
    }

    defaultDataType() {
        const plc = this.currentPLC();
        const profile = this.profileFor(plc);
        return profile?.dataTypes?.includes('Int16') ? 'Int16' : profile?.dataTypes?.[0] || 'UInt16';
    }

    async refreshRows() {
        if (this.switchingPLC) return;
        const plc = this.currentPLC();
        if (!plc) return;
        const rows = this.currentRows().filter((row) => row.address);
        if (!rows.length) return;

        const requestRows = rows.map((row) => ({
            id: row.id,
            address: row.address,
            type: row.dataType
        }));
        const results = await window.electronAPI.readMultiple(plc.name, requestRows);
        const now = this.timeLabel();
        results.forEach((result) => {
            const row = this.currentRows().find((item) => item.id === result.id);
            if (!row) return;
            row.quality = result.quality || (result.error ? 'Bad' : 'Good');
            row.updatedAt = now;
            if (!result.error) {
                row.value = this.formatValue(result.value);
            }
        });
        this.saveRows();
        this.patchRowValues();
    }

    patchRowValues() {
        this.currentRows().forEach((row) => {
            const valueInput = document.querySelector(`input[data-row="${CSS.escape(row.id)}"][data-field="value"]`);
            if (valueInput && document.activeElement !== valueInput) {
                valueInput.value = row.value ?? '';
            }
            const qualityCell = document.querySelector(`tr[data-row="${CSS.escape(row.id)}"] td:nth-child(5) span`);
            if (qualityCell) {
                qualityCell.textContent = row.quality || 'N/A';
                qualityCell.className = this.qualityClass(row.quality);
            }
            const updatedCell = document.querySelector(`tr[data-row="${CSS.escape(row.id)}"] td:nth-child(6) span`);
            if (updatedCell) {
                updatedCell.textContent = row.updatedAt || '--';
            }
        });
    }

    async writeRow(rowId) {
        const plc = this.currentPLC();
        const row = this.currentRows().find((item) => item.id === rowId);
        if (!plc || !row) return;
        const input = document.querySelector(`input[data-row="${CSS.escape(rowId)}"][data-field="value"]`);
        const value = input ? input.value : row.value;
        const result = await window.electronAPI.writeValue({
            plc: plc.name,
            address: row.address,
            type: row.dataType,
            value
        });
        if (result?.success) {
            row.value = this.formatValue(result.value ?? value);
            row.quality = result.quality || 'Good';
            row.updatedAt = this.timeLabel();
            this.toast(`Wrote ${row.address}`);
        } else {
            row.quality = 'Bad';
            this.toast(result?.error || 'Write failed', true);
        }
        this.saveRows();
        this.patchRowValues();
    }

    startRefreshLoop() {
        this.stopRefreshLoop();
        this.refreshTimer = setInterval(() => this.refreshActiveView(), 800);
    }

    stopRefreshLoop() {
        if (this.refreshTimer) {
            clearInterval(this.refreshTimer);
            this.refreshTimer = null;
        }
    }

    showPLCModal(plc) {
        if (!plc) return;
        this.openModal('Edit PLC', `
            <div class="form-grid">
                <div class="form-row">
                    <label>Name</label>
                    <input class="form-input" id="form-name" value="${this.escape(plc.name)}">
                </div>
                <div class="form-row">
                    <label>Host</label>
                    <input class="form-input" id="form-host" value="${this.escape(plc.host || plc.ip)}">
                </div>
                <div class="form-row">
                    <label>Port</label>
                    <input class="form-input" id="form-port" type="number" min="1" max="65535" value="${plc.port}">
                </div>
                <div class="form-row">
                    <label>Unit ID</label>
                    <input class="form-input" id="form-unit" type="number" min="0" max="247" value="${plc.unitId ?? ''}">
                </div>
            </div>
        `, async () => {
            const payload = {
                profileId: plc.profileId,
                name: document.getElementById('form-name').value.trim(),
                host: document.getElementById('form-host').value.trim(),
                port: Number(document.getElementById('form-port').value),
                unitId: document.getElementById('form-unit').value === '' ? null : Number(document.getElementById('form-unit').value)
            };
            const result = await window.electronAPI.updatePLC(plc.name, payload);
            if (result?.success) {
                this.currentPLCName = result.plc.name;
                this.closeModal();
                await this.reloadAll();
                this.toast('PLC updated');
            } else {
                this.toast(result?.error || 'PLC save failed', true);
            }
        }, 'Save');
    }

    showBulkModal() {
        this.openModal('Bulk Add', `
            <div class="form-grid">
                <div class="form-row">
                    <label>Start Address</label>
                    <input class="form-input mono" id="bulk-address" value="${this.escape(this.firstExample())}">
                </div>
                <div class="form-row">
                    <label>Count</label>
                    <input class="form-input" id="bulk-count" type="number" min="1" max="200" value="8">
                </div>
                <div class="form-row full">
                    <label>Data Type</label>
                    <select class="form-select" id="bulk-type">
                        ${(this.profileFor(this.currentPLC())?.dataTypes || ['Bool', 'Int16', 'UInt16', 'Int32', 'Float']).map((type) => `<option value="${type}">${type}</option>`).join('')}
                    </select>
                </div>
            </div>
        `, () => {
            let address = document.getElementById('bulk-address').value.trim();
            const count = Number(document.getElementById('bulk-count').value);
            const dataType = document.getElementById('bulk-type').value;
            for (let index = 0; index < count; index += 1) {
                this.addRow({ tagName: `Bulk ${index + 1}`, address, dataType });
                address = this.incrementAddress(address, dataType);
            }
            this.closeModal();
            this.renderRows();
            this.refreshRows();
        }, 'Add');
    }

    showDBModal(dbNumber = null, size = 2048) {
        const plc = this.currentPLC();
        if (!plc) return;
        this.openModal(dbNumber ? 'Edit DB' : 'Add DB', `
            <div class="form-grid">
                <div class="form-row">
                    <label>DB Number</label>
                    <input class="form-input" id="db-number" type="number" min="1" max="65535" value="${dbNumber || 1}">
                </div>
                <div class="form-row">
                    <label>Size</label>
                    <input class="form-input" id="db-size" type="number" min="1" max="65536" value="${size}">
                </div>
            </div>
        `, async () => {
            const nextDb = Number(document.getElementById('db-number').value);
            const nextSize = Number(document.getElementById('db-size').value);
            const result = dbNumber
                ? await window.electronAPI.updateDB(plc.name, dbNumber, nextDb, nextSize)
                : await window.electronAPI.addDB(plc.name, nextDb, nextSize);
            if (result?.success) {
                this.closeModal();
                this.renderDataBlocks();
                this.toast(dbNumber ? 'DB updated' : 'DB added');
            } else {
                this.toast(result?.error || 'DB save failed', true);
            }
        }, dbNumber ? 'Save' : 'Add');
    }

    async deleteDB(dbNumber) {
        const plc = this.currentPLC();
        if (!plc) return;
        const result = await window.electronAPI.removeDB(plc.name, dbNumber);
        if (result?.success) {
            this.renderDataBlocks();
            this.toast(`DB${dbNumber} deleted`);
        } else {
            this.toast(result?.error || 'Delete DB failed', true);
        }
    }

    openModal(title, bodyHtml, onConfirm, confirmText = 'Confirm', danger = false) {
        document.getElementById('modal-title').textContent = title;
        document.getElementById('modal-body').innerHTML = bodyHtml;
        const confirm = document.getElementById('modal-confirm');
        confirm.textContent = confirmText;
        confirm.className = danger ? 'button danger' : 'button primary';
        this.modalConfirm = onConfirm;
        document.getElementById('modal-overlay').classList.add('active');
    }

    closeModal() {
        document.getElementById('modal-overlay').classList.remove('active');
        this.modalConfirm = null;
    }

    defaultPLCName(profile) {
        const base = {
            'mitsubishi-fx3u': 'FX3U',
            'mitsubishi-q': 'Q',
            'siemens-s7': 'S7',
            'delta-dvp': 'Delta_DVP',
            'delta-as': 'Delta_AS',
            'modbus-client': 'Modbus'
        }[profile?.id] || 'PLC';
        return `${base}_1`;
    }

    incrementAddress(address, dataType) {
        const siemens = address.match(/^(DB\d+\.DB[XBWD])(\d+)(?:\.([0-7]))?$/i);
        if (siemens) {
            const step = dataType === 'Bool' ? 1 : dataType === 'Int32' || dataType === 'UInt32' || dataType === 'Float' ? 4 : 2;
            return `${siemens[1]}${Number(siemens[2]) + step}${siemens[3] ? `.${siemens[3]}` : ''}`.toUpperCase();
        }
        const standard = address.match(/^(\d{5,6})$/);
        if (standard) return String(Number(standard[1]) + 1).padStart(standard[1].length, '0');
        const match = address.match(/^([A-Z]+)([0-9A-F]+)$/i);
        if (!match) return address;
        const prefix = match[1].toUpperCase();
        const raw = match[2].toUpperCase();
        const hexPrefixes = new Set(['W', 'B']);
        const base = hexPrefixes.has(prefix) ? 16 : 10;
        const next = parseInt(raw, base) + 1;
        return `${prefix}${next.toString(base).toUpperCase()}`;
    }

    qualityClass(quality) {
        if (quality === 'Good') return 'quality-good';
        if (quality === 'Bad' || quality === 'Timeout') return 'quality-bad';
        return 'quality-na';
    }

    formatValue(value) {
        if (value === null || value === undefined) return '';
        if (typeof value === 'number' && !Number.isInteger(value)) return String(Number(value.toFixed(5)));
        return String(value);
    }

    valueInputAttributes(dataType) {
        const ranges = {
            Byte: { min: 0, max: 255, step: 1, inputmode: 'numeric' },
            Int16: { min: -32768, max: 32767, step: 1, inputmode: 'numeric' },
            UInt16: { min: 0, max: 65535, step: 1, inputmode: 'numeric' },
            Int32: { min: -2147483648, max: 2147483647, step: 1, inputmode: 'numeric' },
            UInt32: { min: 0, max: 4294967295, step: 1, inputmode: 'numeric' },
            Float: { step: 'any', inputmode: 'decimal' }
        };
        const config = ranges[dataType];
        if (!config) return 'type="text"';

        return Object.entries({
            type: 'number',
            min: config.min,
            max: config.max,
            step: config.step,
            inputmode: config.inputmode
        })
            .filter(([, value]) => value !== undefined)
            .map(([key, value]) => `${key}="${value}"`)
            .join(' ');
    }

    timeLabel() {
        return new Date().toLocaleTimeString([], { hour12: false });
    }

    loadRows() {
        try {
            return JSON.parse(localStorage.getItem('virtual-plc-watch-v1') || '{}');
        } catch {
            return {};
        }
    }

    saveRows() {
        localStorage.setItem('virtual-plc-watch-v1', JSON.stringify(this.rowsByPLC));
    }

    loadMapTypes() {
        try {
            return JSON.parse(localStorage.getItem('virtual-plc-map-types-v1') || '{}');
        } catch {
            return {};
        }
    }

    saveMapTypes() {
        localStorage.setItem('virtual-plc-map-types-v1', JSON.stringify(this.mapTypes));
    }

    loadTheme() {
        const savedTheme = localStorage.getItem('virtual-plc-theme-v1');
        return savedTheme === 'dark' ? 'dark' : 'light';
    }

    saveTheme() {
        localStorage.setItem('virtual-plc-theme-v1', this.theme);
    }

    toggleTheme() {
        this.theme = this.theme === 'dark' ? 'light' : 'dark';
        this.saveTheme();
        this.applyTheme();
    }

    applyTheme() {
        document.documentElement.dataset.theme = this.theme;
        const button = document.getElementById('btn-theme');
        if (!button) return;

        const isDark = this.theme === 'dark';
        const label = isDark ? 'Switch to light theme' : 'Switch to dark theme';
        button.title = label;
        button.setAttribute('aria-label', label);
        button.setAttribute('aria-pressed', String(isDark));
        button.innerHTML = isDark
            ? '<svg class="icon" viewBox="0 0 24 24"><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" /></svg>'
            : '<svg class="icon" viewBox="0 0 24 24"><path d="M21 12.8A8.5 8.5 0 1 1 11.2 3a6.5 6.5 0 0 0 9.8 9.8Z" /></svg>';
    }

    toast(message, error = false) {
        const toast = document.getElementById('toast');
        toast.textContent = message;
        toast.className = `toast active${error ? ' error' : ''}`;
        clearTimeout(this.toastTimer);
        this.toastTimer = setTimeout(() => {
            toast.className = 'toast';
        }, 2800);
    }

    escape(value) {
        return String(value ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }
}

window.addEventListener('DOMContentLoaded', () => {
    window.app = new VirtualPlcApp();
});
