# Virtual-PLC
Virtual PLC

## Virtual PLC Studio

Electron desktop app for creating virtual PLC profiles and interacting with register cells.

Supported profiles:

- Mitsubishi FX3U
- Mitsubishi Q
- Siemens PLC (S7 DB memory, Snap7 server when `python-snap7` is installed)
- Delta DVP / Delta AS (Modbus TCP memory maps)
- Modbus Client (generic Modbus TCP tables)

Run the desktop app:

```cmd
cd memory-manager
npm install
npm start
```

The Electron shell starts `virtualHub/virtual_plc_hub.py` and serves the local API at `http://127.0.0.1:5000`.

## Virtual Delta Modbus TCP

CMD only, no UI:

```cmd
cd virtualDelta
run_dvp.cmd
```

Use `run_as.cmd` instead for AS mode.

Default listen address is `0.0.0.0:502` with full Modbus address range `0..65535` for coils, discrete inputs, holding registers, and input registers. Use `--mode dvp` or `--mode as` to select the Delta PLC profile.
