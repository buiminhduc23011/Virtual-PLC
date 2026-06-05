from __future__ import annotations

import argparse
import signal
import socket
import socketserver
import struct
import sys
import threading
from array import array
from dataclasses import dataclass
from typing import Iterable


MODBUS_ADDRESS_COUNT = 65_536
MAX_READ_BITS = 2_000
MAX_READ_REGISTERS = 125
MAX_WRITE_COILS = 1_968
MAX_WRITE_REGISTERS = 123
MAX_READWRITE_WRITE_REGISTERS = 121
MAX_TCP_LENGTH = 254

ILLEGAL_FUNCTION = 0x01
ILLEGAL_DATA_ADDRESS = 0x02
ILLEGAL_DATA_VALUE = 0x03
SERVER_DEVICE_FAILURE = 0x04

COIL_FUNCTIONS = (0x01, 0x05, 0x0F)
DISCRETE_INPUT_FUNCTIONS = (0x02,)
HOLDING_REGISTER_FUNCTIONS = (0x03, 0x06, 0x10, 0x16, 0x17)
INPUT_REGISTER_FUNCTIONS = (0x04,)


class ModbusError(Exception):
    def __init__(self, code: int, message: str):
        super().__init__(message)
        self.code = code


@dataclass(frozen=True)
class DeviceRange:
    device: str
    function_codes: tuple[int, ...]
    start_address: int
    end_address: int
    start_index: int = 0
    number_base: int = 10
    bit_word_width: int | None = None
    note: str = ""

    def contains(self, function_code: int, address: int) -> bool:
        return function_code in self.function_codes and self.start_address <= address <= self.end_address

    def format_device(self, address: int) -> str:
        index = self.start_index + address - self.start_address
        if self.bit_word_width:
            word = self.start_index + ((address - self.start_address) // self.bit_word_width)
            bit = (address - self.start_address) % self.bit_word_width
            return f"{self.device}{word}.{bit}"
        if self.number_base == 8:
            return f"{self.device}{index:03o}"
        return f"{self.device}{index}"

    def format_line(self) -> str:
        address_range = f"0x{self.start_address:04X}-0x{self.end_address:04X}"
        function_codes = "/".join(f"{function_code:02X}" for function_code in self.function_codes)
        note = f" ({self.note})" if self.note else ""
        return (
            f"{self.device:<3} FC {function_codes:<14} raw {address_range} -> "
            f"{self.format_device(self.start_address)}..{self.format_device(self.end_address)}{note}"
        )


@dataclass(frozen=True)
class PLCProfile:
    mode: str
    display_name: str
    description: str
    device_ranges: tuple[DeviceRange, ...]

    def format_address(self, function_code: int, address: int | None) -> str | None:
        if address is None:
            return None
        for device_range in self.device_ranges:
            if device_range.contains(function_code, address):
                return device_range.format_device(address)
        return None

    def format_map(self) -> str:
        lines = [f"{self.display_name}: {self.description}"]
        lines.extend(device_range.format_line() for device_range in self.device_ranges)
        return "\n".join(lines)


DVP_PROFILE = PLCProfile(
    mode="dvp",
    display_name="Delta DVP",
    description="DVP-style device map, for example D0 uses raw holding-register address 0x1000.",
    device_ranges=(
        DeviceRange("S", COIL_FUNCTIONS, 0x0000, 0x03FF, note="step relays"),
        DeviceRange("X", DISCRETE_INPUT_FUNCTIONS, 0x0400, 0x04FF, number_base=8, note="octal input points"),
        DeviceRange("Y", COIL_FUNCTIONS, 0x0500, 0x05FF, number_base=8, note="octal output points"),
        DeviceRange("T", COIL_FUNCTIONS, 0x0600, 0x06FF, note="timer contacts"),
        DeviceRange("T", HOLDING_REGISTER_FUNCTIONS, 0x0600, 0x06FF, note="timer present values"),
        DeviceRange("M", COIL_FUNCTIONS, 0x0800, 0x0DFF, note="internal relays"),
        DeviceRange("C", COIL_FUNCTIONS, 0x0E00, 0x0EFF, note="counter contacts"),
        DeviceRange("C", HOLDING_REGISTER_FUNCTIONS, 0x0E00, 0x0EC7, note="16-bit counter words"),
        DeviceRange("D", HOLDING_REGISTER_FUNCTIONS, 0x1000, 0x1FFF, note="data registers D0-D4095"),
        DeviceRange("M", COIL_FUNCTIONS, 0xB000, 0xB9FF, start_index=1536, note="extended internal relays"),
        DeviceRange("D", HOLDING_REGISTER_FUNCTIONS, 0x9000, 0xA70F, start_index=4096, note="extended data registers"),
    ),
)

AS_PROFILE = PLCProfile(
    mode="as",
    display_name="Delta AS",
    description="AS-style device map, for example D0 uses raw holding-register address 0x0000.",
    device_ranges=(
        DeviceRange("M", COIL_FUNCTIONS, 0x0000, 0x1FFF, note="internal relays"),
        DeviceRange("D", HOLDING_REGISTER_FUNCTIONS, 0x0000, 0x752F, note="data registers D0-D29999"),
        DeviceRange("SM", COIL_FUNCTIONS, 0x4000, 0x4FFF, note="special internal relays"),
        DeviceRange("S", COIL_FUNCTIONS, 0x5000, 0x57FF, note="step relays"),
        DeviceRange("X", DISCRETE_INPUT_FUNCTIONS, 0x6000, 0x63FF, bit_word_width=16, note="input points"),
        DeviceRange("X", INPUT_REGISTER_FUNCTIONS, 0x8000, 0x803F, note="input words"),
        DeviceRange("Y", COIL_FUNCTIONS, 0xA000, 0xA3FF, bit_word_width=16, note="output points"),
        DeviceRange("Y", HOLDING_REGISTER_FUNCTIONS, 0xA000, 0xA03F, note="output words"),
        DeviceRange("SR", HOLDING_REGISTER_FUNCTIONS, 0xC000, 0xC7FF, note="special registers"),
        DeviceRange("T", COIL_FUNCTIONS, 0xE000, 0xE1FF, note="timer contacts"),
        DeviceRange("T", HOLDING_REGISTER_FUNCTIONS, 0xE000, 0xE1FF, note="timer present values"),
        DeviceRange("C", COIL_FUNCTIONS, 0xF000, 0xF1FF, note="counter contacts"),
        DeviceRange("C", HOLDING_REGISTER_FUNCTIONS, 0xF000, 0xF1FF, note="counter present values"),
        DeviceRange("HC", COIL_FUNCTIONS, 0xFC00, 0xFCFF, note="high-speed counter contacts"),
        DeviceRange("HC", HOLDING_REGISTER_FUNCTIONS, 0xFC00, 0xFCFF, note="high-speed counter present values"),
        DeviceRange("E", HOLDING_REGISTER_FUNCTIONS, 0xFE00, 0xFE09, note="index registers"),
    ),
)

PLC_PROFILES = {
    DVP_PROFILE.mode: DVP_PROFILE,
    AS_PROFILE.mode: AS_PROFILE,
}


def get_profile(mode: str) -> PLCProfile:
    try:
        return PLC_PROFILES[mode.lower()]
    except KeyError as exc:
        valid_modes = ", ".join(sorted(PLC_PROFILES))
        raise ValueError(f"unknown PLC mode {mode!r}; expected one of: {valid_modes}") from exc


class ModbusMemory:
    """Full 16-bit Modbus address space for the four standard data tables."""

    def __init__(self, address_count: int = MODBUS_ADDRESS_COUNT):
        if address_count < 1 or address_count > MODBUS_ADDRESS_COUNT:
            raise ValueError("address_count must be between 1 and 65536")

        self.address_count = address_count
        self.coils = bytearray(address_count)
        self.discrete_inputs = bytearray(address_count)
        self.holding_registers = array("H", [0]) * address_count
        self.input_registers = array("H", [0]) * address_count
        self._lock = threading.RLock()

    def read_bits(self, table: str, address: int, quantity: int) -> list[int]:
        self._check_range(address, quantity)
        bits = self._bit_table(table)
        with self._lock:
            return [1 if value else 0 for value in bits[address : address + quantity]]

    def write_bits(self, table: str, address: int, values: Iterable[int]) -> None:
        values = [1 if value else 0 for value in values]
        self._check_range(address, len(values))
        bits = self._bit_table(table)
        with self._lock:
            bits[address : address + len(values)] = bytes(values)

    def read_registers(self, table: str, address: int, quantity: int) -> list[int]:
        self._check_range(address, quantity)
        registers = self._register_table(table)
        with self._lock:
            return [int(value) & 0xFFFF for value in registers[address : address + quantity]]

    def write_registers(self, table: str, address: int, values: Iterable[int]) -> None:
        values = [int(value) & 0xFFFF for value in values]
        self._check_range(address, len(values))
        registers = self._register_table(table)
        with self._lock:
            registers[address : address + len(values)] = array("H", values)

    def mask_write_register(self, address: int, and_mask: int, or_mask: int) -> None:
        self._check_range(address, 1)
        with self._lock:
            current = int(self.holding_registers[address]) & 0xFFFF
            new_value = (current & and_mask) | (or_mask & (~and_mask & 0xFFFF))
            self.holding_registers[address] = new_value & 0xFFFF

    def _check_range(self, address: int, quantity: int) -> None:
        if quantity < 1:
            raise ModbusError(ILLEGAL_DATA_VALUE, "quantity must be at least 1")
        if address < 0 or address + quantity > self.address_count:
            raise ModbusError(ILLEGAL_DATA_ADDRESS, "address range is outside Modbus memory")

    def _bit_table(self, table: str) -> bytearray:
        if table == "coils":
            return self.coils
        if table == "discrete_inputs":
            return self.discrete_inputs
        raise ValueError(f"unknown bit table: {table}")

    def _register_table(self, table: str) -> array:
        if table == "holding_registers":
            return self.holding_registers
        if table == "input_registers":
            return self.input_registers
        raise ValueError(f"unknown register table: {table}")


@dataclass(frozen=True)
class RequestSummary:
    function_code: int
    address: int | None = None
    quantity: int | None = None

    def format(self) -> str:
        parts = [f"FC{self.function_code:02d}"]
        if self.address is not None:
            parts.append(f"addr={self.address}")
        if self.quantity is not None:
            parts.append(f"qty={self.quantity}")
        return " ".join(parts)


def handle_modbus_pdu(memory: ModbusMemory, pdu: bytes) -> tuple[bytes, RequestSummary]:
    if not pdu:
        raise ModbusError(ILLEGAL_DATA_VALUE, "empty Modbus PDU")

    function_code = pdu[0]

    if function_code in (0x01, 0x02):
        return _read_bits(memory, pdu, function_code)
    if function_code in (0x03, 0x04):
        return _read_registers(memory, pdu, function_code)
    if function_code == 0x05:
        return _write_single_coil(memory, pdu)
    if function_code == 0x06:
        return _write_single_register(memory, pdu)
    if function_code == 0x0F:
        return _write_multiple_coils(memory, pdu)
    if function_code == 0x10:
        return _write_multiple_registers(memory, pdu)
    if function_code == 0x16:
        return _mask_write_register(memory, pdu)
    if function_code == 0x17:
        return _read_write_multiple_registers(memory, pdu)

    raise ModbusError(ILLEGAL_FUNCTION, f"unsupported function code: {function_code}")


def _read_bits(memory: ModbusMemory, pdu: bytes, function_code: int) -> tuple[bytes, RequestSummary]:
    if len(pdu) != 5:
        raise ModbusError(ILLEGAL_DATA_VALUE, "read bits request must be 5 bytes")
    address, quantity = struct.unpack(">HH", pdu[1:5])
    if quantity < 1 or quantity > MAX_READ_BITS:
        raise ModbusError(ILLEGAL_DATA_VALUE, "read bits quantity must be 1..2000")

    table = "coils" if function_code == 0x01 else "discrete_inputs"
    values = memory.read_bits(table, address, quantity)
    packed = _pack_bits(values)
    response = bytes([function_code, len(packed)]) + packed
    return response, RequestSummary(function_code, address, quantity)


def _read_registers(memory: ModbusMemory, pdu: bytes, function_code: int) -> tuple[bytes, RequestSummary]:
    if len(pdu) != 5:
        raise ModbusError(ILLEGAL_DATA_VALUE, "read registers request must be 5 bytes")
    address, quantity = struct.unpack(">HH", pdu[1:5])
    if quantity < 1 or quantity > MAX_READ_REGISTERS:
        raise ModbusError(ILLEGAL_DATA_VALUE, "read register quantity must be 1..125")

    table = "holding_registers" if function_code == 0x03 else "input_registers"
    values = memory.read_registers(table, address, quantity)
    response = bytes([function_code, quantity * 2]) + _pack_registers(values)
    return response, RequestSummary(function_code, address, quantity)


def _write_single_coil(memory: ModbusMemory, pdu: bytes) -> tuple[bytes, RequestSummary]:
    if len(pdu) != 5:
        raise ModbusError(ILLEGAL_DATA_VALUE, "write single coil request must be 5 bytes")
    address, value = struct.unpack(">HH", pdu[1:5])
    if value == 0xFF00:
        bit_value = 1
    elif value == 0x0000:
        bit_value = 0
    else:
        raise ModbusError(ILLEGAL_DATA_VALUE, "single coil value must be 0x0000 or 0xFF00")

    memory.write_bits("coils", address, [bit_value])
    return pdu, RequestSummary(0x05, address, 1)


def _write_single_register(memory: ModbusMemory, pdu: bytes) -> tuple[bytes, RequestSummary]:
    if len(pdu) != 5:
        raise ModbusError(ILLEGAL_DATA_VALUE, "write single register request must be 5 bytes")
    address, value = struct.unpack(">HH", pdu[1:5])
    memory.write_registers("holding_registers", address, [value])
    return pdu, RequestSummary(0x06, address, 1)


def _write_multiple_coils(memory: ModbusMemory, pdu: bytes) -> tuple[bytes, RequestSummary]:
    if len(pdu) < 6:
        raise ModbusError(ILLEGAL_DATA_VALUE, "write multiple coils request is too short")
    address, quantity, byte_count = struct.unpack(">HHB", pdu[1:6])
    expected_byte_count = (quantity + 7) // 8
    if quantity < 1 or quantity > MAX_WRITE_COILS:
        raise ModbusError(ILLEGAL_DATA_VALUE, "write coil quantity must be 1..1968")
    if byte_count != expected_byte_count or len(pdu) != 6 + byte_count:
        raise ModbusError(ILLEGAL_DATA_VALUE, "write coil byte count does not match quantity")

    values = _unpack_bits(pdu[6:], quantity)
    memory.write_bits("coils", address, values)
    response = struct.pack(">BHH", 0x0F, address, quantity)
    return response, RequestSummary(0x0F, address, quantity)


def _write_multiple_registers(memory: ModbusMemory, pdu: bytes) -> tuple[bytes, RequestSummary]:
    if len(pdu) < 6:
        raise ModbusError(ILLEGAL_DATA_VALUE, "write multiple registers request is too short")
    address, quantity, byte_count = struct.unpack(">HHB", pdu[1:6])
    if quantity < 1 or quantity > MAX_WRITE_REGISTERS:
        raise ModbusError(ILLEGAL_DATA_VALUE, "write register quantity must be 1..123")
    if byte_count != quantity * 2 or len(pdu) != 6 + byte_count:
        raise ModbusError(ILLEGAL_DATA_VALUE, "write register byte count does not match quantity")

    values = _unpack_registers(pdu[6:])
    memory.write_registers("holding_registers", address, values)
    response = struct.pack(">BHH", 0x10, address, quantity)
    return response, RequestSummary(0x10, address, quantity)


def _mask_write_register(memory: ModbusMemory, pdu: bytes) -> tuple[bytes, RequestSummary]:
    if len(pdu) != 7:
        raise ModbusError(ILLEGAL_DATA_VALUE, "mask write register request must be 7 bytes")
    address, and_mask, or_mask = struct.unpack(">HHH", pdu[1:7])
    memory.mask_write_register(address, and_mask, or_mask)
    return pdu, RequestSummary(0x16, address, 1)


def _read_write_multiple_registers(memory: ModbusMemory, pdu: bytes) -> tuple[bytes, RequestSummary]:
    if len(pdu) < 10:
        raise ModbusError(ILLEGAL_DATA_VALUE, "read/write registers request is too short")

    read_address, read_quantity, write_address, write_quantity, byte_count = struct.unpack(">HHHHB", pdu[1:10])
    if read_quantity < 1 or read_quantity > MAX_READ_REGISTERS:
        raise ModbusError(ILLEGAL_DATA_VALUE, "read quantity must be 1..125")
    if write_quantity < 1 or write_quantity > MAX_READWRITE_WRITE_REGISTERS:
        raise ModbusError(ILLEGAL_DATA_VALUE, "write quantity must be 1..121")
    if byte_count != write_quantity * 2 or len(pdu) != 10 + byte_count:
        raise ModbusError(ILLEGAL_DATA_VALUE, "read/write byte count does not match write quantity")

    write_values = _unpack_registers(pdu[10:])
    memory.write_registers("holding_registers", write_address, write_values)
    read_values = memory.read_registers("holding_registers", read_address, read_quantity)
    response = bytes([0x17, read_quantity * 2]) + _pack_registers(read_values)
    return response, RequestSummary(0x17, read_address, read_quantity)


def _pack_bits(values: Iterable[int]) -> bytes:
    values = list(values)
    output = bytearray((len(values) + 7) // 8)
    for index, value in enumerate(values):
        if value:
            output[index // 8] |= 1 << (index % 8)
    return bytes(output)


def _unpack_bits(data: bytes, quantity: int) -> list[int]:
    values: list[int] = []
    for index in range(quantity):
        values.append(1 if data[index // 8] & (1 << (index % 8)) else 0)
    return values


def _pack_registers(values: Iterable[int]) -> bytes:
    values = [int(value) & 0xFFFF for value in values]
    if not values:
        return b""
    return struct.pack(">" + "H" * len(values), *values)


def _unpack_registers(data: bytes) -> list[int]:
    if len(data) % 2:
        raise ModbusError(ILLEGAL_DATA_VALUE, "register payload must contain whole 16-bit words")
    if not data:
        return []
    return list(struct.unpack(">" + "H" * (len(data) // 2), data))


class VirtualDeltaRequestHandler(socketserver.BaseRequestHandler):
    def handle(self) -> None:
        self.request.settimeout(self.server.client_timeout)
        peer = f"{self.client_address[0]}:{self.client_address[1]}"

        while True:
            try:
                header = _recv_exact(self.request, 7)
                if not header:
                    return

                transaction_id, protocol_id, length, unit_id = struct.unpack(">HHHB", header)
                if protocol_id != 0 or length < 2 or length > MAX_TCP_LENGTH:
                    return

                pdu = _recv_exact(self.request, length - 1)
                if not pdu:
                    return

                response_pdu, summary = self.server.process_request_pdu(unit_id, pdu)
                response = _build_mbap_response(transaction_id, unit_id, response_pdu)
                self.request.sendall(response)

                if self.server.log_requests:
                    decoded_address = self.server.profile.format_address(summary.function_code, summary.address)
                    decoded_text = f" ({decoded_address})" if decoded_address else ""
                    print(f"[{peer}] {self.server.profile.mode} unit={unit_id} {summary.format()}{decoded_text}")
            except (ConnectionError, TimeoutError, OSError):
                return
            except Exception as exc:
                if self.server.log_requests:
                    print(f"[{peer}] error: {exc}")
                return


class VirtualDeltaModbusServer(socketserver.ThreadingMixIn, socketserver.TCPServer):
    allow_reuse_address = True
    daemon_threads = True

    def __init__(
        self,
        server_address: tuple[str, int],
        memory: ModbusMemory | None = None,
        profile: PLCProfile = DVP_PROFILE,
        unit_id: int | None = None,
        log_requests: bool = False,
        client_timeout: float = 30.0,
    ):
        super().__init__(server_address, VirtualDeltaRequestHandler)
        self.memory = memory or ModbusMemory()
        self.profile = profile
        self.unit_id = unit_id
        self.log_requests = log_requests
        self.client_timeout = client_timeout

    def process_request_pdu(self, unit_id: int, pdu: bytes) -> tuple[bytes, RequestSummary]:
        function_code = pdu[0] if pdu else 0
        if self.unit_id is not None and unit_id != self.unit_id:
            return _exception_response(function_code, ILLEGAL_DATA_ADDRESS), RequestSummary(function_code)

        try:
            return handle_modbus_pdu(self.memory, pdu)
        except ModbusError as exc:
            return _exception_response(function_code, exc.code), RequestSummary(function_code)
        except Exception:
            return _exception_response(function_code, SERVER_DEVICE_FAILURE), RequestSummary(function_code)


def _recv_exact(sock: socket.socket, size: int) -> bytes:
    chunks = bytearray()
    while len(chunks) < size:
        chunk = sock.recv(size - len(chunks))
        if not chunk:
            if chunks:
                raise ConnectionError("connection closed mid-frame")
            return b""
        chunks.extend(chunk)
    return bytes(chunks)


def _build_mbap_response(transaction_id: int, unit_id: int, pdu: bytes) -> bytes:
    return struct.pack(">HHHB", transaction_id, 0, len(pdu) + 1, unit_id) + pdu


def _exception_response(function_code: int, code: int) -> bytes:
    return bytes([(function_code | 0x80) & 0xFF, code & 0xFF])


def build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Virtual Delta PLC Modbus TCP server")
    parser.add_argument(
        "--mode",
        choices=sorted(PLC_PROFILES),
        default="dvp",
        help="PLC profile to emulate, default: dvp",
    )
    parser.add_argument("--host", default="0.0.0.0", help="IP address to bind, default: 0.0.0.0")
    parser.add_argument("--port", type=int, default=502, help="TCP port to bind, default: 502")
    parser.add_argument(
        "--unit-id",
        type=int,
        default=None,
        help="Only answer this unit id. Default: answer every unit id.",
    )
    parser.add_argument("--log-requests", action="store_true", help="Print each Modbus request")
    parser.add_argument("--show-map", action="store_true", help="Print the selected PLC profile map and exit")
    parser.add_argument("--client-timeout", type=float, default=30.0, help="Client socket timeout in seconds")
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_arg_parser()
    args = parser.parse_args(argv)

    if args.port < 1 or args.port > 65_535:
        parser.error("--port must be between 1 and 65535")
    if args.unit_id is not None and (args.unit_id < 0 or args.unit_id > 247):
        parser.error("--unit-id must be between 0 and 247")

    profile = get_profile(args.mode)
    if args.show_map:
        print(profile.format_map())
        return 0

    try:
        server = VirtualDeltaModbusServer(
            (args.host, args.port),
            profile=profile,
            unit_id=args.unit_id,
            log_requests=args.log_requests,
            client_timeout=args.client_timeout,
        )
    except OSError as exc:
        print(f"Cannot start Modbus TCP server on {args.host}:{args.port}: {exc}", file=sys.stderr)
        return 1

    stop_event = threading.Event()

    def stop_server(_signum: int | None = None, _frame: object | None = None) -> None:
        if stop_event.is_set():
            return
        stop_event.set()
        print("\nStopping Virtual Delta Modbus TCP server...")
        threading.Thread(target=server.shutdown, daemon=True).start()

    signal.signal(signal.SIGINT, stop_server)
    if hasattr(signal, "SIGTERM"):
        signal.signal(signal.SIGTERM, stop_server)

    print("=" * 60)
    print("Virtual Delta PLC - Modbus TCP")
    print("=" * 60)
    print(f"Mode: {profile.display_name} ({profile.mode})")
    print(f"Profile: {profile.description}")
    print(f"Listening: {args.host}:{args.port}")
    print("Unit ID: all" if args.unit_id is None else f"Unit ID: {args.unit_id}")
    print("Memory: coils, discrete inputs, holding registers, input registers")
    print("Address range: 0..65535 for every table")
    print("Supported FC: 01 02 03 04 05 06 15 16 22 23")
    print("Press Ctrl+C to stop.")
    print("=" * 60)

    try:
        server.serve_forever(poll_interval=0.25)
    except OSError as exc:
        print(f"Server error: {exc}", file=sys.stderr)
        return 1
    finally:
        server.server_close()

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
