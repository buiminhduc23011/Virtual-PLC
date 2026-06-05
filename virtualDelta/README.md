# Virtual Delta Modbus TCP

Server PLC Delta ao chay bang Modbus TCP, khong can giao dien va khong hoi tuong tac.

## Chay bang CMD

```cmd
cd virtualDelta
run_dvp.cmd
```

Hoac chay truc tiep:

```cmd
py -3 virtual_delta_modbus.py --mode dvp --host 0.0.0.0 --port 502
```

Chay mode PLC AS rieng:

```cmd
run_as.cmd
```

Hoac:

```cmd
py -3 virtual_delta_modbus.py --mode as --host 0.0.0.0 --port 502
```

Neu port 502 dang bi ung dung khac dung, doi tam sang port khac de test:

```cmd
py -3 virtual_delta_modbus.py --mode dvp --port 1502
py -3 virtual_delta_modbus.py --mode as --port 1503
```

## Vung nho Modbus

Server mo full dia chi Modbus 16-bit `0..65535` cho moi bang:

- Coils: function `01`, `05`, `15`
- Discrete inputs: function `02`
- Holding registers: function `03`, `06`, `16`, `22`, `23`
- Input registers: function `04`

Tat ca gia tri ban dau la `0`. Dia chi tren day la dia chi raw trong Modbus PDU; neu phan mem client hien thi kieu `40001`, `00001`, hay bat dau tu 1, can cau hinh offset theo cach client do quy doi.

## Mode DVP va AS

Hai mode dung chung Modbus TCP server nhung co profile device map rieng:

- `--mode dvp`: DVP-style map, vi du `D0` la raw holding register `0x1000`.
- `--mode as`: AS-style map, vi du `D0` la raw holding register `0x0000`.

Xem map profile:

```cmd
py -3 virtual_delta_modbus.py --mode dvp --show-map
py -3 virtual_delta_modbus.py --mode as --show-map
```

Neu bat log:

```cmd
py -3 virtual_delta_modbus.py --mode as --log-requests
```

Log se hien mode va ten device theo profile, vi du `as unit=1 FC03 addr=0 qty=1 (D0)`.
