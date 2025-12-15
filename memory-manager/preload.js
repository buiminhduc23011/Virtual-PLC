const { contextBridge, ipcRenderer } = require('electron');

// Expose protected methods to renderer process
contextBridge.exposeInMainWorld('electronAPI', {
    // Window controls
    minimize: () => ipcRenderer.invoke('window:minimize'),
    maximize: () => ipcRenderer.invoke('window:maximize'),
    close: () => ipcRenderer.invoke('window:close'),

    // PLC operations
    getAllPLCs: () => ipcRenderer.invoke('plc:getAll'),
    getDataBlocks: (plcName) => ipcRenderer.invoke('plc:getDataBlocks', plcName),
    createPLC: (name, ip, port) => ipcRenderer.invoke('plc:create', { name, ip, port }),
    updatePLC: (oldName, name, ip, port) => ipcRenderer.invoke('plc:update', { oldName, name, ip, port }),
    deletePLC: (name) => ipcRenderer.invoke('plc:delete', { name }),
    addDB: (plcName, dbNumber, size) => ipcRenderer.invoke('plc:addDB', { plcName, dbNumber, size }),
    removeDB: (plcName, dbNumber) => ipcRenderer.invoke('plc:removeDB', { plcName, dbNumber }),
    updateDB: (plcName, oldDbNumber, newDbNumber, newSize) =>
        ipcRenderer.invoke('plc:updateDB', { plcName, oldDbNumber, newDbNumber, newSize }),


    // Value operations
    readValue: (plcName, dbNumber, offset, dataType, bitOffset = 0, stringLength = 254) =>
        ipcRenderer.invoke('plc:readValue', { plcName, dbNumber, offset, dataType, bitOffset, stringLength }),
    writeValue: (plcName, dbNumber, offset, dataType, value, bitOffset = 0, stringLength = 254) =>
        ipcRenderer.invoke('plc:writeValue', { plcName, dbNumber, offset, dataType, value, bitOffset, stringLength }),
    readMultiple: (plcName, addresses) =>
        ipcRenderer.invoke('plc:readMultiple', { plcName, addresses }),

    // Server operations
    getServerStatus: () => ipcRenderer.invoke('server:status'),
    restartServer: () => ipcRenderer.invoke('server:restart')
});
