from __future__ import annotations

import math
import re
import signal
import struct
import sys
import threading
import time
from array import array
from dataclasses import dataclass
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from flask import Flask, jsonify, request
from flask_cors import CORS

from virtualDelta.virtual_delta_modbus import AS_PROFILE, DVP_PROFILE, ModbusMemory, VirtualDeltaModbusServer

try:
    from snap7.server import Server as Snap7Server
    from snap7.type import SrvArea, WordLen
except Exception:  # pragma: no cover - depends on optional local native package
    Snap7Server = None
    SrvArea = None
    WordLen = None


DATA_TYPE_ALIASES = {
    "BOOL": "Bool",
    "BOOLEAN": "Bool",
    "BIT": "Bool",
    "BYTE": "Byte",
    "INT": "Int16",
    "INT16": "Int16",
    "SHORT": "Int16",
    "WORD": "UInt16",
    "UINT": "UInt16",
    "UINT16": "UInt16",
    "DINT": "Int32",
    "INT32": "Int32",
    "DWORD": "UInt32",
    "UDINT": "UInt32",
    "UINT32": "UInt32",
    "REAL": "Float",
    "FLOAT": "Float",
    "STRING": "String",
}

TYPE_WORD_COUNTS = {
    "Bool": 1,
    "Byte": 1,
    "Int16": 1,
    "UInt16": 1,
    "Int32": 2,
    "UInt32": 2,
    "Float": 2,
    "String": 8,
}

TYPE_BYTE_COUNTS = {
    "Bool": 1,
    "Byte": 1,
    "Int16": 2,
    "UInt16": 2,
    "Int32": 4,
    "UInt32": 4,
    "Float": 4,
    "String": 16,
}

PROFILE_DEFINITIONS: dict[str, dict[str, Any]] = {
    "mitsubishi-fx3u": {
        "id": "mitsubishi-fx3u",
        "name": "Mitsubishi FX3U",
        "vendor": "Mitsubishi",
        "protocol": "FX3U memory profile",
        "serverKind": "memory",
        "defaultHost": "127.0.0.1",
        "defaultPort": 5007,
        "addressExamples": ["M0", "X0", "Y0", "D0", "T0", "C0"],
        "dataTypes": ["Bool", "Int16", "UInt16", "Int32", "UInt32", "Float"],
        "areas": [
            {"code": "X", "kind": "bit", "name": "Input relay", "range": "X0-X177"},
            {"code": "Y", "kind": "bit", "name": "Output relay", "range": "Y0-Y177"},
            {"code": "M", "kind": "bit", "name": "Internal relay", "range": "M0-M7999"},
            {"code": "S", "kind": "bit", "name": "Step relay", "range": "S0-S4095"},
            {"code": "D", "kind": "word", "name": "Data register", "range": "D0-D7999"},
            {"code": "T", "kind": "word", "name": "Timer current", "range": "T0-T511"},
            {"code": "C", "kind": "word", "name": "Counter current", "range": "C0-C255"},
        ],
        "defaultRegisters": [
            {"tagName": "Run Enable", "address": "M0", "dataType": "Bool"},
            {"tagName": "Start Input", "address": "X0", "dataType": "Bool"},
            {"tagName": "Counter Value", "address": "D0", "dataType": "Int16"},
        ],
    },
    "mitsubishi-q": {
        "id": "mitsubishi-q",
        "name": "Mitsubishi Q",
        "vendor": "Mitsubishi",
        "protocol": "Q/L MC memory profile",
        "serverKind": "memory",
        "defaultHost": "127.0.0.1",
        "defaultPort": 5008,
        "addressExamples": ["M0", "X0", "Y0", "D0", "W0", "ZR0"],
        "dataTypes": ["Bool", "Int16", "UInt16", "Int32", "UInt32", "Float"],
        "areas": [
            {"code": "X", "kind": "bit", "name": "Input relay", "range": "X0-X1FFF"},
            {"code": "Y", "kind": "bit", "name": "Output relay", "range": "Y0-Y1FFF"},
            {"code": "M", "kind": "bit", "name": "Internal relay", "range": "M0-M32767"},
            {"code": "B", "kind": "bit", "name": "Link relay", "range": "B0-B1FFF"},
            {"code": "D", "kind": "word", "name": "Data register", "range": "D0-D32767"},
            {"code": "W", "kind": "word", "name": "Link register", "range": "W0-W1FFF"},
            {"code": "ZR", "kind": "word", "name": "File register", "range": "ZR0-ZR32767"},
        ],
        "defaultRegisters": [
            {"tagName": "Machine Ready", "address": "M0", "dataType": "Bool"},
            {"tagName": "Output Command", "address": "Y0", "dataType": "Bool"},
            {"tagName": "Production Count", "address": "D0", "dataType": "UInt16"},
        ],
    },
    "siemens-s7": {
        "id": "siemens-s7",
        "name": "Siemens PLC",
        "vendor": "Siemens",
        "protocol": "S7 server",
        "serverKind": "snap7",
        "defaultHost": "0.0.0.0",
        "defaultPort": 1102,
        "addressExamples": ["DB1.DBX0.0", "DB1.DBB0", "DB1.DBW0", "DB1.DBD0"],
        "dataTypes": ["Bool", "Byte", "Int16", "UInt16", "Int32", "UInt32", "Float", "String"],
        "areas": [
            {"code": "DB", "kind": "byte", "name": "Data block", "range": "DB1-DB128"},
            {"code": "M", "kind": "byte", "name": "Marker", "range": "M0-M4095"},
            {"code": "I", "kind": "byte", "name": "Input image", "range": "I0-I4095"},
            {"code": "Q", "kind": "byte", "name": "Output image", "range": "Q0-Q4095"},
        ],
        "defaultRegisters": [
            {"tagName": "Run Bit", "address": "DB1.DBX0.0", "dataType": "Bool"},
            {"tagName": "Speed Setpoint", "address": "DB1.DBW2", "dataType": "Int16"},
            {"tagName": "Temperature", "address": "DB1.DBD4", "dataType": "Float"},
        ],
        "defaultDbs": [{"dbNumber": 1, "size": 2048}, {"dbNumber": 2, "size": 2048}],
    },
    "delta-dvp": {
        "id": "delta-dvp",
        "name": "Delta DVP",
        "vendor": "Delta",
        "protocol": "Modbus TCP DVP map",
        "serverKind": "modbus",
        "profileMode": "dvp",
        "defaultHost": "0.0.0.0",
        "defaultPort": 1502,
        "addressExamples": ["M0", "X0", "Y0", "D0", "T0", "C0"],
        "dataTypes": ["Bool", "Int16", "UInt16", "Int32", "UInt32", "Float"],
        "areas": [
            {"code": "M", "kind": "bit", "name": "Internal relay", "range": "M0-M1535"},
            {"code": "X", "kind": "bit", "name": "Input point", "range": "X000-X377"},
            {"code": "Y", "kind": "bit", "name": "Output point", "range": "Y000-Y377"},
            {"code": "D", "kind": "word", "name": "Data register", "range": "D0-D4095"},
            {"code": "T", "kind": "word", "name": "Timer value", "range": "T0-T255"},
            {"code": "C", "kind": "word", "name": "Counter value", "range": "C0-C199"},
        ],
        "defaultRegisters": [
            {"tagName": "M Relay", "address": "M0", "dataType": "Bool"},
            {"tagName": "Output Y0", "address": "Y0", "dataType": "Bool"},
            {"tagName": "Data D0", "address": "D0", "dataType": "Int16"},
        ],
    },
    "delta-as": {
        "id": "delta-as",
        "name": "Delta AS",
        "vendor": "Delta",
        "protocol": "Modbus TCP AS map",
        "serverKind": "modbus",
        "profileMode": "as",
        "defaultHost": "0.0.0.0",
        "defaultPort": 1504,
        "addressExamples": ["M0", "X0", "Y0", "D0", "SR0", "E0"],
        "dataTypes": ["Bool", "Int16", "UInt16", "Int32", "UInt32", "Float"],
        "areas": [
            {"code": "M", "kind": "bit", "name": "Internal relay", "range": "M0-M8191"},
            {"code": "X", "kind": "bit", "name": "Input point", "range": "X0-X1023"},
            {"code": "Y", "kind": "bit", "name": "Output point", "range": "Y0-Y1023"},
            {"code": "D", "kind": "word", "name": "Data register", "range": "D0-D29999"},
            {"code": "SR", "kind": "word", "name": "Special register", "range": "SR0-SR2047"},
            {"code": "E", "kind": "word", "name": "Index register", "range": "E0-E9"},
        ],
        "defaultRegisters": [
            {"tagName": "AS Relay", "address": "M0", "dataType": "Bool"},
            {"tagName": "AS Word", "address": "D0", "dataType": "Int16"},
        ],
    },
    "modbus-client": {
        "id": "modbus-client",
        "name": "Modbus Client",
        "vendor": "Generic",
        "protocol": "Modbus TCP tables",
        "serverKind": "modbus",
        "profileMode": "generic",
        "defaultHost": "0.0.0.0",
        "defaultPort": 1503,
        "addressExamples": ["C1", "DI1", "IR1", "HR1", "40001"],
        "dataTypes": ["Bool", "Int16", "UInt16", "Int32", "UInt32", "Float"],
        "areas": [
            {"code": "C", "kind": "bit", "name": "Coil", "range": "00001-09999"},
            {"code": "DI", "kind": "bit", "name": "Discrete input", "range": "10001-19999"},
            {"code": "IR", "kind": "word", "name": "Input register", "range": "30001-39999"},
            {"code": "HR", "kind": "word", "name": "Holding register", "range": "40001-49999"},
        ],
        "defaultRegisters": [
            {"tagName": "Coil 1", "address": "C1", "dataType": "Bool"},
            {"tagName": "Holding 1", "address": "HR1", "dataType": "UInt16"},
            {"tagName": "Input 1", "address": "IR1", "dataType": "UInt16"},
        ],
    },
}


@dataclass(frozen=True)
class ParsedAddress:
    area: str
    kind: str
    index: int
    db_number: int | None = None
    bit: int = 0
    canonical: str = ""


def normalize_data_type(data_type: str | None) -> str:
    key = (data_type or "Int16").strip().upper()
    if key not in DATA_TYPE_ALIASES:
        raise ValueError(f"Unsupported data type '{data_type}'.")
    return DATA_TYPE_ALIASES[key]


def parse_bool(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value != 0
    text = str(value).strip().lower()
    if text in {"1", "true", "on", "yes"}:
        return True
    if text in {"0", "false", "off", "no"}:
        return False
    raise ValueError(f"Cannot parse boolean value '{value}'.")


def words_to_value(words: list[int], data_type: str) -> Any:
    data_type = normalize_data_type(data_type)
    if data_type == "Bool":
        return bool(words[0] & 1)
    if data_type == "Byte":
        return words[0] & 0xFF
    if data_type == "Int16":
        value = words[0] & 0xFFFF
        return value - 0x10000 if value & 0x8000 else value
    if data_type == "UInt16":
        return words[0] & 0xFFFF
    if data_type in {"Int32", "UInt32", "Float"}:
        high = words[0] & 0xFFFF
        low = words[1] & 0xFFFF
        raw = struct.pack(">HH", high, low)
        if data_type == "Float":
            value = struct.unpack(">f", raw)[0]
            return 0.0 if math.isclose(value, 0.0, abs_tol=1e-12) else value
        unsigned = struct.unpack(">I", raw)[0]
        if data_type == "UInt32":
            return unsigned
        return unsigned - 0x1_0000_0000 if unsigned & 0x8000_0000 else unsigned
    if data_type == "String":
        chars = []
        for word in words:
            high = (word >> 8) & 0xFF
            low = word & 0xFF
            for byte in (high, low):
                if byte == 0:
                    return "".join(chars)
                chars.append(chr(byte))
        return "".join(chars)
    raise ValueError(f"Unsupported data type '{data_type}'.")


def value_to_words(value: Any, data_type: str) -> list[int]:
    data_type = normalize_data_type(data_type)
    if data_type == "Bool":
        return [1 if parse_bool(value) else 0]
    if data_type == "Byte":
        return [int(value) & 0xFF]
    if data_type == "Int16":
        return [int(value) & 0xFFFF]
    if data_type == "UInt16":
        return [int(value) & 0xFFFF]
    if data_type == "Int32":
        raw = struct.pack(">i", int(value))
        return list(struct.unpack(">HH", raw))
    if data_type == "UInt32":
        raw = struct.pack(">I", int(value) & 0xFFFF_FFFF)
        return list(struct.unpack(">HH", raw))
    if data_type == "Float":
        raw = struct.pack(">f", float(value))
        return list(struct.unpack(">HH", raw))
    if data_type == "String":
        encoded = str(value).encode("ascii", "replace")[:16]
        if len(encoded) % 2:
            encoded += b"\x00"
        return [int.from_bytes(encoded[index : index + 2], "big") for index in range(0, len(encoded), 2)]
    raise ValueError(f"Unsupported data type '{data_type}'.")


def bytes_to_value(buffer: Any, offset: int, data_type: str, bit: int = 0) -> Any:
    data_type = normalize_data_type(data_type)
    if data_type == "Bool":
        return bool(buffer[offset] & (1 << bit))
    if data_type == "Byte":
        return int(buffer[offset]) & 0xFF
    if data_type == "Int16":
        return struct.unpack_from(">h", buffer, offset)[0]
    if data_type == "UInt16":
        return struct.unpack_from(">H", buffer, offset)[0]
    if data_type == "Int32":
        return struct.unpack_from(">i", buffer, offset)[0]
    if data_type == "UInt32":
        return struct.unpack_from(">I", buffer, offset)[0]
    if data_type == "Float":
        value = struct.unpack_from(">f", buffer, offset)[0]
        return 0.0 if math.isclose(value, 0.0, abs_tol=1e-12) else value
    if data_type == "String":
        end = offset
        while end < min(len(buffer), offset + TYPE_BYTE_COUNTS["String"]) and buffer[end] != 0:
            end += 1
        return bytes(buffer[offset:end]).decode("ascii", "replace")
    raise ValueError(f"Unsupported data type '{data_type}'.")


def value_to_bytes(buffer: Any, offset: int, value: Any, data_type: str, bit: int = 0) -> None:
    data_type = normalize_data_type(data_type)
    if data_type == "Bool":
        current = int(buffer[offset]) & 0xFF
        if parse_bool(value):
            buffer[offset] = current | (1 << bit)
        else:
            buffer[offset] = current & ~(1 << bit)
        return
    if data_type == "Byte":
        buffer[offset] = int(value) & 0xFF
        return
    if data_type == "Int16":
        struct.pack_into(">h", buffer, offset, int(value))
        return
    if data_type == "UInt16":
        struct.pack_into(">H", buffer, offset, int(value) & 0xFFFF)
        return
    if data_type == "Int32":
        struct.pack_into(">i", buffer, offset, int(value))
        return
    if data_type == "UInt32":
        struct.pack_into(">I", buffer, offset, int(value) & 0xFFFF_FFFF)
        return
    if data_type == "Float":
        struct.pack_into(">f", buffer, offset, float(value))
        return
    if data_type == "String":
        encoded = str(value).encode("ascii", "replace")[: TYPE_BYTE_COUNTS["String"]]
        for index in range(TYPE_BYTE_COUNTS["String"]):
            buffer[offset + index] = encoded[index] if index < len(encoded) else 0
        return
    raise ValueError(f"Unsupported data type '{data_type}'.")


def ensure_buffer(buffer: Any, offset: int, data_type: str) -> None:
    span = TYPE_BYTE_COUNTS[normalize_data_type(data_type)]
    if offset < 0 or offset + span > len(buffer):
        raise ValueError("Address is outside configured memory.")


class VirtualPlcDevice:
    def __init__(
        self,
        name: str,
        profile_id: str,
        host: str | None = None,
        port: int | None = None,
        unit_id: int | None = None,
        autostart: bool = True,
    ):
        if profile_id not in PROFILE_DEFINITIONS:
            raise ValueError(f"Unknown PLC profile '{profile_id}'.")
        self.name = name
        self.profile_id = profile_id
        self.profile = PROFILE_DEFINITIONS[profile_id]
        self.host = host or self.profile["defaultHost"]
        self.port = int(port or self.profile["defaultPort"])
        self.unit_id = unit_id
        self.status = "stopped"
        self.protocol_message = "Memory profile ready"
        self._lock = threading.RLock()
        self._snap7_server: Any = None
        self._modbus_server: VirtualDeltaModbusServer | None = None
        self._server_thread: threading.Thread | None = None

        self.db_buffers: dict[int, Any] = {}
        self.bit_areas: dict[str, bytearray] = {}
        self.word_areas: dict[str, array] = {}
        self.modbus_memory: ModbusMemory | None = None

        self._init_memory()
        if autostart:
            self.start()

    def _init_memory(self) -> None:
        server_kind = self.profile["serverKind"]
        if server_kind == "snap7":
            dbs = self.profile.get("defaultDbs", [{"dbNumber": 1, "size": 2048}])
            for db in dbs:
                self.add_db(int(db["dbNumber"]), int(db["size"]), register=False)
            for area in ("M", "I", "Q"):
                self.bit_areas[area] = bytearray(8192)
            return

        if server_kind == "modbus":
            self.modbus_memory = ModbusMemory()
            return

        for area in self.profile["areas"]:
            code = area["code"].upper()
            if area["kind"] == "bit":
                self.bit_areas[code] = bytearray(65_536)
            else:
                self.word_areas[code] = array("H", [0]) * 65_536

    def start(self) -> None:
        server_kind = self.profile["serverKind"]
        if server_kind == "snap7":
            self._start_snap7()
        elif server_kind == "modbus":
            self._start_modbus()
        else:
            self.status = "memory"
            self.protocol_message = "Memory profile active"

    def stop(self) -> None:
        if self._snap7_server:
            try:
                self._snap7_server.stop()
            except Exception:
                pass
            self._snap7_server = None
        if self._modbus_server:
            try:
                self._modbus_server.shutdown()
                self._modbus_server.server_close()
            except Exception:
                pass
            self._modbus_server = None
        if self._server_thread and self._server_thread.is_alive():
            self._server_thread.join(timeout=1)
        self._server_thread = None
        self.status = "stopped"

    def _start_snap7(self) -> None:
        if Snap7Server is None or SrvArea is None or WordLen is None:
            self.status = "memory"
            self.protocol_message = "python-snap7 is not available; API memory is active"
            return
        try:
            server = Snap7Server()
            for db_number, buffer in self.db_buffers.items():
                server.register_area(SrvArea.DB, db_number, buffer)
            server.start(tcp_port=self.port)
        except Exception as exc:
            self.status = "memory"
            self.protocol_message = f"S7 server not started: {exc}"
            return

        self._snap7_server = server
        self.status = "listening"
        self.protocol_message = f"S7 listening on {self.host}:{self.port}"

        def pump_events() -> None:
            while self._snap7_server is server:
                try:
                    server.pick_event()
                except Exception:
                    break
                time.sleep(0.1)

        self._server_thread = threading.Thread(target=pump_events, daemon=True)
        self._server_thread.start()

    def _start_modbus(self) -> None:
        if self.modbus_memory is None:
            self.modbus_memory = ModbusMemory()
        profile_mode = self.profile.get("profileMode")
        modbus_profile = AS_PROFILE if profile_mode == "as" else DVP_PROFILE
        try:
            server = VirtualDeltaModbusServer(
                (self.host, self.port),
                memory=self.modbus_memory,
                profile=modbus_profile,
                unit_id=self.unit_id,
                log_requests=False,
            )
        except Exception as exc:
            self.status = "memory"
            self.protocol_message = f"Modbus server not started: {exc}"
            return

        self._modbus_server = server
        self.port = int(server.server_address[1])
        self.status = "listening"
        self.protocol_message = f"Modbus TCP listening on {self.host}:{self.port}"
        self._server_thread = threading.Thread(target=server.serve_forever, daemon=True)
        self._server_thread.start()

    def add_db(self, db_number: int, size: int, register: bool = True) -> None:
        if size < 1 or size > 65_536:
            raise ValueError("DB size must be 1..65536 bytes.")
        if Snap7Server is not None and WordLen is not None:
            buffer = (WordLen.Byte.ctype * size)()
        else:
            buffer = bytearray(size)
        self.db_buffers[db_number] = buffer
        if register and self._snap7_server and SrvArea is not None:
            self._snap7_server.register_area(SrvArea.DB, db_number, buffer)

    def remove_db(self, db_number: int) -> None:
        if db_number in self.db_buffers:
            del self.db_buffers[db_number]
        else:
            raise ValueError(f"DB{db_number} does not exist.")

    def update_db(self, old_db_number: int, new_db_number: int, new_size: int) -> None:
        self.remove_db(old_db_number)
        self.add_db(new_db_number, new_size)

    def list_dbs(self) -> list[dict[str, int]]:
        return [{"dbNumber": db, "size": len(buf)} for db, buf in sorted(self.db_buffers.items())]

    def get_info(self) -> dict[str, Any]:
        return {
            "id": self.name,
            "name": self.name,
            "type": self.profile_id,
            "profileId": self.profile_id,
            "profileName": self.profile["name"],
            "vendor": self.profile["vendor"],
            "protocol": self.profile["protocol"],
            "serverKind": self.profile["serverKind"],
            "ip": self.host,
            "host": self.host,
            "port": self.port,
            "unitId": self.unit_id,
            "status": self.status,
            "protocolMessage": self.protocol_message,
            "running": self.status in {"listening", "memory"},
            "areas": self.profile["areas"],
            "addressExamples": self.profile["addressExamples"],
            "dataTypes": self.profile["dataTypes"],
            "defaultRegisters": self.profile.get("defaultRegisters", []),
            "dataBlocks": self.list_dbs(),
        }

    def read(self, address: str, data_type: str) -> Any:
        data_type = normalize_data_type(data_type)
        parsed = self.parse_address(address, data_type)
        with self._lock:
            if self.profile["serverKind"] == "snap7":
                return self._read_siemens(parsed, data_type)
            if self.profile["serverKind"] == "modbus":
                return self._read_modbus(parsed, data_type)
            return self._read_memory_profile(parsed, data_type)

    def write(self, address: str, data_type: str, value: Any) -> None:
        data_type = normalize_data_type(data_type)
        parsed = self.parse_address(address, data_type)
        with self._lock:
            if self.profile["serverKind"] == "snap7":
                self._write_siemens(parsed, data_type, value)
            elif self.profile["serverKind"] == "modbus":
                self._write_modbus(parsed, data_type, value)
            else:
                self._write_memory_profile(parsed, data_type, value)

    def parse_address(self, address: str, data_type: str) -> ParsedAddress:
        if self.profile["serverKind"] == "snap7":
            return parse_siemens_address(address)
        if self.profile_id == "modbus-client":
            return parse_modbus_address(address, data_type)
        if self.profile_id.startswith("delta-"):
            return parse_delta_address(address, data_type, self.profile_id)
        if self.profile_id.startswith("mitsubishi-"):
            return parse_mitsubishi_address(address, data_type, self.profile_id)
        raise ValueError(f"Unsupported profile '{self.profile_id}'.")

    def _read_siemens(self, parsed: ParsedAddress, data_type: str) -> Any:
        if parsed.area == "DB":
            if parsed.db_number not in self.db_buffers:
                raise ValueError(f"DB{parsed.db_number} does not exist.")
            buffer = self.db_buffers[parsed.db_number]
        else:
            buffer = self.bit_areas.setdefault(parsed.area, bytearray(8192))
        ensure_buffer(buffer, parsed.index, data_type)
        return bytes_to_value(buffer, parsed.index, data_type, parsed.bit)

    def _write_siemens(self, parsed: ParsedAddress, data_type: str, value: Any) -> None:
        if parsed.area == "DB":
            if parsed.db_number not in self.db_buffers:
                self.add_db(parsed.db_number or 1, 2048)
            buffer = self.db_buffers[parsed.db_number or 1]
        else:
            buffer = self.bit_areas.setdefault(parsed.area, bytearray(8192))
        ensure_buffer(buffer, parsed.index, data_type)
        value_to_bytes(buffer, parsed.index, value, data_type, parsed.bit)

    def _read_memory_profile(self, parsed: ParsedAddress, data_type: str) -> Any:
        if parsed.kind == "bit":
            bits = self.bit_areas.setdefault(parsed.area, bytearray(65_536))
            return bool(bits[parsed.index])
        words = self.word_areas.setdefault(parsed.area, array("H", [0]) * 65_536)
        count = TYPE_WORD_COUNTS[data_type]
        return words_to_value([int(value) for value in words[parsed.index : parsed.index + count]], data_type)

    def _write_memory_profile(self, parsed: ParsedAddress, data_type: str, value: Any) -> None:
        if parsed.kind == "bit":
            bits = self.bit_areas.setdefault(parsed.area, bytearray(65_536))
            bits[parsed.index] = 1 if parse_bool(value) else 0
            return
        words = self.word_areas.setdefault(parsed.area, array("H", [0]) * 65_536)
        values = value_to_words(value, data_type)
        words[parsed.index : parsed.index + len(values)] = array("H", values)

    def _read_modbus(self, parsed: ParsedAddress, data_type: str) -> Any:
        if self.modbus_memory is None:
            raise ValueError("Modbus memory is not available.")
        if parsed.kind == "bit":
            table = "discrete_inputs" if parsed.area == "discrete-input" else "coils"
            return bool(self.modbus_memory.read_bits(table, parsed.index, 1)[0])
        table = "input_registers" if parsed.area == "input-register" else "holding_registers"
        words = self.modbus_memory.read_registers(table, parsed.index, TYPE_WORD_COUNTS[data_type])
        return words_to_value(words, data_type)

    def _write_modbus(self, parsed: ParsedAddress, data_type: str, value: Any) -> None:
        if self.modbus_memory is None:
            raise ValueError("Modbus memory is not available.")
        if parsed.kind == "bit":
            table = "discrete_inputs" if parsed.area == "discrete-input" else "coils"
            self.modbus_memory.write_bits(table, parsed.index, [1 if parse_bool(value) else 0])
            return
        table = "input_registers" if parsed.area == "input-register" else "holding_registers"
        self.modbus_memory.write_registers(table, parsed.index, value_to_words(value, data_type))


SIEMENS_DB_BIT = re.compile(r"^DB(?P<db>\d+)\.DBX(?P<byte>\d+)\.(?P<bit>[0-7])$", re.IGNORECASE)
SIEMENS_DB_WORD = re.compile(r"^DB(?P<db>\d+)\.DB(?P<kind>B|W|D)(?P<offset>\d+)$", re.IGNORECASE)
SIEMENS_AREA_BIT = re.compile(r"^(?P<area>I|Q|M)(?P<byte>\d+)\.(?P<bit>[0-7])$", re.IGNORECASE)
SIEMENS_AREA_WORD = re.compile(r"^(?P<area>I|Q|M)(?P<kind>B|W|D)(?P<offset>\d+)$", re.IGNORECASE)
DEVICE_ADDRESS = re.compile(r"^(?P<prefix>DI|IR|HR|ZR|SR|SM|SD|DX|DY|TN|CN|TC|CC|TS|CS|SN|SC|SS|D|M|X|Y|R|S|T|C|L|F|V|B|W|Z|E)(?P<number>[0-9A-F]+)$", re.IGNORECASE)


def parse_siemens_address(address: str) -> ParsedAddress:
    text = address.strip().upper()
    match = SIEMENS_DB_BIT.match(text)
    if match:
        return ParsedAddress(
            area="DB",
            kind="bit",
            db_number=int(match.group("db")),
            index=int(match.group("byte")),
            bit=int(match.group("bit")),
            canonical=text,
        )
    match = SIEMENS_DB_WORD.match(text)
    if match:
        return ParsedAddress(
            area="DB",
            kind="byte",
            db_number=int(match.group("db")),
            index=int(match.group("offset")),
            canonical=text,
        )
    match = SIEMENS_AREA_BIT.match(text)
    if match:
        return ParsedAddress(
            area=match.group("area").upper(),
            kind="bit",
            index=int(match.group("byte")),
            bit=int(match.group("bit")),
            canonical=text,
        )
    match = SIEMENS_AREA_WORD.match(text)
    if match:
        return ParsedAddress(
            area=match.group("area").upper(),
            kind="byte",
            index=int(match.group("offset")),
            canonical=text,
        )
    raise ValueError(f"Invalid Siemens address '{address}'.")


def parse_device_token(prefix: str, number: str, profile_id: str) -> int:
    prefix = prefix.upper()
    if profile_id == "mitsubishi-fx3u" and prefix in {"X", "Y"}:
        return int(number, 8)
    if profile_id == "delta-dvp" and prefix in {"X", "Y"}:
        return int(number, 8)
    if prefix in {"X", "Y", "B", "W", "DX", "DY"} and profile_id in {"mitsubishi-q"}:
        return int(number, 16)
    return int(number, 10)


def parse_mitsubishi_address(address: str, data_type: str, profile_id: str) -> ParsedAddress:
    text = address.strip().upper()
    match = DEVICE_ADDRESS.match(text)
    if not match:
        raise ValueError(f"Invalid Mitsubishi address '{address}'.")
    prefix = match.group("prefix").upper()
    number = parse_device_token(prefix, match.group("number"), profile_id)
    bit_areas = {"M", "X", "Y", "S", "L", "F", "B", "SM", "TS", "TC", "CS", "CC"}
    kind = "bit" if prefix in bit_areas else "word"
    return ParsedAddress(area=prefix, kind=kind, index=number, canonical=f"{prefix}{match.group('number').upper()}")


def parse_delta_address(address: str, data_type: str, profile_id: str) -> ParsedAddress:
    text = address.strip().upper()
    match = DEVICE_ADDRESS.match(text)
    if not match:
        raise ValueError(f"Invalid Delta address '{address}'.")
    prefix = match.group("prefix").upper()
    number = parse_device_token(prefix, match.group("number"), profile_id)

    if profile_id == "delta-as":
        bit_map = {"M": 0x0000, "SM": 0x4000, "S": 0x5000, "X": 0x6000, "Y": 0xA000, "T": 0xE000, "C": 0xF000}
        word_map = {"D": 0x0000, "X": 0x8000, "Y": 0xA000, "SR": 0xC000, "T": 0xE000, "C": 0xF000, "E": 0xFE00}
    else:
        bit_map = {"S": 0x0000, "X": 0x0400, "Y": 0x0500, "T": 0x0600, "M": 0x0800, "C": 0x0E00}
        word_map = {"T": 0x0600, "C": 0x0E00, "D": 0x1000}

    bit_areas = {"M", "X", "Y", "S", "TS", "TC", "CS", "CC"}
    if data_type == "Bool" or prefix in bit_areas:
        base = bit_map.get(prefix)
        if base is None:
            raise ValueError(f"Delta bit area '{prefix}' is not supported.")
        area = "discrete-input" if prefix == "X" else "coils"
        return ParsedAddress(area=area, kind="bit", index=base + number, canonical=f"{prefix}{match.group('number').upper()}")

    base = word_map.get(prefix)
    if base is None:
        raise ValueError(f"Delta word area '{prefix}' is not supported.")
    area = "input-register" if prefix == "IR" else "holding-register"
    return ParsedAddress(area=area, kind="word", index=base + number, canonical=f"{prefix}{match.group('number').upper()}")


def parse_modbus_address(address: str, data_type: str) -> ParsedAddress:
    text = address.strip().upper()
    if text.isdigit() and len(text) >= 5:
        number = int(text)
        if 1 <= number <= 9999:
            return ParsedAddress(area="coils", kind="bit", index=number - 1, canonical=text)
        if 10001 <= number <= 19999:
            return ParsedAddress(area="discrete-input", kind="bit", index=number - 10001, canonical=text)
        if 30001 <= number <= 39999:
            return ParsedAddress(area="input-register", kind="word", index=number - 30001, canonical=text)
        if 40001 <= number <= 49999:
            return ParsedAddress(area="holding-register", kind="word", index=number - 40001, canonical=text)
        raise ValueError(f"Invalid Modbus address '{address}'.")

    match = DEVICE_ADDRESS.match(text)
    if not match:
        raise ValueError(f"Invalid Modbus address '{address}'.")
    prefix = match.group("prefix").upper()
    number = int(match.group("number"), 10)
    if prefix == "C":
        return ParsedAddress(area="coils", kind="bit", index=number - 1, canonical=text)
    if prefix == "DI":
        return ParsedAddress(area="discrete-input", kind="bit", index=number - 1, canonical=text)
    if prefix == "IR":
        return ParsedAddress(area="input-register", kind="word", index=normalize_modbus_register(number, 30001), canonical=text)
    if prefix == "HR":
        return ParsedAddress(area="holding-register", kind="word", index=normalize_modbus_register(number, 40001), canonical=text)
    raise ValueError(f"Unsupported Modbus area '{prefix}'.")


def normalize_modbus_register(number: int, base_address: int) -> int:
    return number - base_address if number >= base_address else number - 1


class VirtualPlcManager:
    def __init__(self, autostart_defaults: bool = True):
        self._devices: dict[str, VirtualPlcDevice] = {}
        self._lock = threading.RLock()
        if autostart_defaults:
            self.load_defaults()

    def load_defaults(self) -> None:
        try:
            self.create_device("FX3U_1", "mitsubishi-fx3u", "127.0.0.1", 5007)
        except Exception as exc:
            print(f"Could not create default PLC: {exc}", file=sys.stderr)

    def stop_all(self) -> None:
        with self._lock:
            for device in self._devices.values():
                device.stop()

    def list_profiles(self) -> list[dict[str, Any]]:
        return list(PROFILE_DEFINITIONS.values())

    def list_devices(self) -> list[dict[str, Any]]:
        with self._lock:
            return [device.get_info() for device in self._devices.values()]

    def get_device(self, name: str) -> VirtualPlcDevice:
        with self._lock:
            if name not in self._devices:
                raise KeyError(f"PLC '{name}' not found.")
            return self._devices[name]

    def create_device(
        self,
        name: str,
        profile_id: str,
        host: str | None = None,
        port: int | None = None,
        unit_id: int | None = None,
    ) -> VirtualPlcDevice:
        clean_name = name.strip()
        if not clean_name:
            raise ValueError("PLC name is required.")
        with self._lock:
            if self._devices:
                raise ValueError("Only one virtual PLC can be active at a time.")
            if clean_name in self._devices:
                raise ValueError(f"PLC '{clean_name}' already exists.")
            device = VirtualPlcDevice(clean_name, profile_id, host=host, port=port, unit_id=unit_id)
            self._devices[clean_name] = device
            return device

    def update_device(self, old_name: str, payload: dict[str, Any]) -> VirtualPlcDevice:
        with self._lock:
            old = self.get_device(old_name)
            info = old.get_info()
            new_name = payload.get("name") or info["name"]
            profile_id = payload.get("profileId") or payload.get("type") or info["profileId"]
            host = payload.get("host") or payload.get("ip") or info["host"]
            port = int(payload.get("port") or info["port"])
            unit_id = payload.get("unitId", info["unitId"])
            old.stop()
            del self._devices[old_name]
            try:
                updated = VirtualPlcDevice(new_name, profile_id, host=host, port=port, unit_id=unit_id)
            except Exception:
                old.start()
                self._devices[old_name] = old
                raise
            self._devices[new_name] = updated
            return updated

    def delete_device(self, name: str) -> None:
        with self._lock:
            device = self.get_device(name)
            device.stop()
            del self._devices[name]


def request_json() -> dict[str, Any]:
    return request.get_json(silent=True) or {}


def error_response(message: str, status: int = 400):
    return jsonify({"success": False, "error": message}), status


def coerce_legacy_address(payload: dict[str, Any]) -> tuple[str, str]:
    data_type = normalize_data_type(payload.get("type") or payload.get("dataType"))
    address = payload.get("address")
    if address:
        return str(address), data_type

    db_number = payload.get("db") if "db" in payload else payload.get("dbNumber")
    offset = payload.get("offset")
    bit = payload.get("bit") if "bit" in payload else payload.get("bitOffset", 0)
    if db_number is None or offset is None:
        raise ValueError("Address is required.")
    if data_type == "Bool":
        return f"DB{db_number}.DBX{offset}.{bit}", data_type
    selector = {"Byte": "DBB", "Int16": "DBW", "UInt16": "DBW", "Int32": "DBD", "UInt32": "DBD", "Float": "DBD", "String": "DBB"}[data_type]
    return f"DB{db_number}.{selector}{offset}", data_type


def create_app(manager: VirtualPlcManager | None = None, autostart_defaults: bool = True) -> Flask:
    app = Flask(__name__)
    CORS(app)
    plc_manager = manager or VirtualPlcManager(autostart_defaults=autostart_defaults)
    app.config["PLC_MANAGER"] = plc_manager

    @app.get("/")
    def index():
        return jsonify({"name": "Virtual PLC Hub", "profiles": len(PROFILE_DEFINITIONS)})

    @app.get("/api/profiles")
    def get_profiles():
        return jsonify(plc_manager.list_profiles())

    @app.get("/api/plcs")
    def get_plcs():
        return jsonify(plc_manager.list_devices())

    @app.post("/api/plcs")
    def create_plc():
        payload = request_json()
        try:
            profile_id = payload.get("profileId") or payload.get("type") or "modbus-client"
            device = plc_manager.create_device(
                payload.get("name", ""),
                profile_id,
                host=payload.get("host") or payload.get("ip"),
                port=int(payload["port"]) if payload.get("port") else None,
                unit_id=int(payload["unitId"]) if payload.get("unitId") not in (None, "") else None,
            )
            return jsonify({"success": True, "plc": device.get_info()})
        except Exception as exc:
            return error_response(str(exc))

    @app.put("/api/plcs/<name>")
    def update_plc(name: str):
        try:
            device = plc_manager.update_device(name, request_json())
            return jsonify({"success": True, "plc": device.get_info()})
        except KeyError as exc:
            return error_response(str(exc), 404)
        except Exception as exc:
            return error_response(str(exc))

    @app.delete("/api/plcs/<name>")
    def delete_plc(name: str):
        try:
            plc_manager.delete_device(name)
            return jsonify({"success": True})
        except KeyError as exc:
            return error_response(str(exc), 404)
        except Exception as exc:
            return error_response(str(exc))

    @app.get("/api/plc/<plc_name>/dbs")
    def get_dbs(plc_name: str):
        try:
            return jsonify(plc_manager.get_device(plc_name).list_dbs())
        except KeyError as exc:
            return error_response(str(exc), 404)

    @app.post("/api/plc/<plc_name>/dbs")
    def add_db(plc_name: str):
        payload = request_json()
        try:
            device = plc_manager.get_device(plc_name)
            device.add_db(int(payload.get("dbNumber") or payload.get("db")), int(payload.get("size", 2048)))
            return jsonify({"success": True, "dataBlocks": device.list_dbs()})
        except Exception as exc:
            return error_response(str(exc))

    @app.put("/api/plc/<plc_name>/dbs/<int:db_number>")
    def update_db(plc_name: str, db_number: int):
        payload = request_json()
        try:
            device = plc_manager.get_device(plc_name)
            device.update_db(db_number, int(payload.get("dbNumber", db_number)), int(payload.get("size", 2048)))
            return jsonify({"success": True, "dataBlocks": device.list_dbs()})
        except Exception as exc:
            return error_response(str(exc))

    @app.delete("/api/plc/<plc_name>/dbs/<int:db_number>")
    def remove_db(plc_name: str, db_number: int):
        try:
            device = plc_manager.get_device(plc_name)
            device.remove_db(db_number)
            return jsonify({"success": True, "dataBlocks": device.list_dbs()})
        except Exception as exc:
            return error_response(str(exc))

    @app.post("/api/read")
    def read_value():
        payload = request_json()
        try:
            plc_name = payload.get("plc") or payload.get("plcName") or payload.get("name")
            device = plc_manager.get_device(plc_name)
            address, data_type = coerce_legacy_address(payload)
            value = device.read(address, data_type)
            return jsonify({"value": value, "quality": "Good", "address": address, "type": data_type})
        except KeyError as exc:
            return error_response(str(exc), 404)
        except Exception as exc:
            return error_response(str(exc))

    @app.post("/api/write")
    def write_value():
        payload = request_json()
        try:
            plc_name = payload.get("plc") or payload.get("plcName") or payload.get("name")
            device = plc_manager.get_device(plc_name)
            address, data_type = coerce_legacy_address(payload)
            device.write(address, data_type, payload.get("value"))
            value = device.read(address, data_type)
            return jsonify({"success": True, "value": value, "quality": "Good", "address": address, "type": data_type})
        except KeyError as exc:
            return error_response(str(exc), 404)
        except Exception as exc:
            return error_response(str(exc))

    @app.post("/api/read/batch")
    def read_batch():
        payload = request_json()
        plc_name = payload.get("plc") or payload.get("plcName")
        try:
            device = plc_manager.get_device(plc_name)
            results = []
            for item in payload.get("addresses", []):
                try:
                    address, data_type = coerce_legacy_address(item)
                    value = device.read(address, data_type)
                    results.append({**item, "address": address, "type": data_type, "value": value, "quality": "Good"})
                except Exception as exc:
                    results.append({**item, "value": None, "quality": "Bad", "error": str(exc)})
            return jsonify(results)
        except KeyError as exc:
            return error_response(str(exc), 404)

    @app.get("/api/status")
    def status():
        return jsonify({"connected": True, "plcs": len(plc_manager.list_devices())})

    return app


def build_arg_parser():
    import argparse

    parser = argparse.ArgumentParser(description="Virtual PLC Hub API")
    parser.add_argument("--host", default="0.0.0.0", help="API host, default: 0.0.0.0")
    parser.add_argument("--port", type=int, default=5000, help="API port, default: 5000")
    parser.add_argument("--no-defaults", action="store_true", help="Do not create default virtual PLCs")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_arg_parser().parse_args(argv)
    manager = VirtualPlcManager(autostart_defaults=not args.no_defaults)
    app = create_app(manager=manager, autostart_defaults=False)

    def stop_all(_signum: int | None = None, _frame: object | None = None) -> None:
        manager.stop_all()

    signal.signal(signal.SIGINT, stop_all)
    if hasattr(signal, "SIGTERM"):
        signal.signal(signal.SIGTERM, stop_all)

    print("=" * 60)
    print("Virtual PLC Hub")
    print("=" * 60)
    for device in manager.list_devices():
        print(f"{device['name']:<14} {device['profileName']:<18} {device['protocolMessage']}")
    print(f"API: http://{args.host}:{args.port}")
    print("=" * 60)
    try:
        app.run(host=args.host, port=args.port, debug=False, use_reloader=False)
    finally:
        manager.stop_all()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
