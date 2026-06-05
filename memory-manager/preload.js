const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    minimize: () => ipcRenderer.invoke('window:minimize'),
    maximize: () => ipcRenderer.invoke('window:maximize'),
    close: () => ipcRenderer.invoke('window:close'),

    getProfiles: () => ipcRenderer.invoke('profiles:getAll'),

    getAllPLCs: () => ipcRenderer.invoke('plc:getAll'),
    createPLC: (payload) => ipcRenderer.invoke('plc:create', payload),
    updatePLC: (oldName, payload) => ipcRenderer.invoke('plc:update', { oldName, ...payload }),
    deletePLC: (name) => ipcRenderer.invoke('plc:delete', { name }),

    getDataBlocks: (plcName) => ipcRenderer.invoke('plc:getDataBlocks', plcName),
    addDB: (plcName, dbNumber, size) => ipcRenderer.invoke('plc:addDB', { plcName, dbNumber, size }),
    removeDB: (plcName, dbNumber) => ipcRenderer.invoke('plc:removeDB', { plcName, dbNumber }),
    updateDB: (plcName, oldDbNumber, newDbNumber, newSize) =>
        ipcRenderer.invoke('plc:updateDB', { plcName, oldDbNumber, newDbNumber, newSize }),

    readValue: (payload) => ipcRenderer.invoke('plc:readValue', payload),
    writeValue: (payload) => ipcRenderer.invoke('plc:writeValue', payload),
    readMultiple: (plcName, addresses) => ipcRenderer.invoke('plc:readMultiple', { plc: plcName, addresses }),

    getServerStatus: () => ipcRenderer.invoke('server:status'),
    restartServer: () => ipcRenderer.invoke('server:restart')
});
