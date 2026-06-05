import socket
import struct
import threading
import unittest

from .virtual_delta_modbus import (
    ModbusMemory,
    VirtualDeltaModbusServer,
    build_arg_parser,
    get_profile,
    handle_modbus_pdu,
)


def mbap(transaction_id, unit_id, pdu):
    return struct.pack(">HHHB", transaction_id, 0, len(pdu) + 1, unit_id) + pdu


class VirtualDeltaModbusTests(unittest.TestCase):
    def test_profile_maps_dvp_and_as_registers_separately(self):
        dvp = get_profile("dvp")
        as_profile = get_profile("as")

        self.assertEqual(dvp.format_address(0x03, 0x1000), "D0")
        self.assertEqual(dvp.format_address(0x03, 0x0000), None)
        self.assertEqual(as_profile.format_address(0x03, 0x0000), "D0")
        self.assertEqual(as_profile.format_address(0x03, 0x1000), "D4096")

    def test_profile_maps_dvp_octal_io_and_as_bit_words(self):
        dvp = get_profile("dvp")
        as_profile = get_profile("as")

        self.assertEqual(dvp.format_address(0x02, 0x0408), "X010")
        self.assertEqual(dvp.format_address(0x01, 0x0508), "Y010")
        self.assertEqual(as_profile.format_address(0x02, 0x600F), "X0.15")
        self.assertEqual(as_profile.format_address(0x01, 0xA010), "Y1.0")

    def test_cli_accepts_plc_mode(self):
        args = build_arg_parser().parse_args(["--mode", "as", "--port", "1502", "--show-map"])

        self.assertEqual(args.mode, "as")
        self.assertEqual(args.port, 1502)
        self.assertTrue(args.show_map)

    def test_holding_register_round_trip(self):
        memory = ModbusMemory()

        write_response, _summary = handle_modbus_pdu(memory, bytes.fromhex("06 000A 04D2"))
        read_response, _summary = handle_modbus_pdu(memory, bytes.fromhex("03 000A 0001"))

        self.assertEqual(write_response, bytes.fromhex("06 000A 04D2"))
        self.assertEqual(read_response, bytes.fromhex("03 02 04D2"))

    def test_multiple_coil_round_trip(self):
        memory = ModbusMemory()

        write_response, _summary = handle_modbus_pdu(memory, bytes.fromhex("0F 0008 000A 02 5503"))
        read_response, _summary = handle_modbus_pdu(memory, bytes.fromhex("01 0008 000A"))

        self.assertEqual(write_response, bytes.fromhex("0F 0008 000A"))
        self.assertEqual(read_response, bytes.fromhex("01 02 5503"))

    def test_out_of_range_read_returns_modbus_error(self):
        server = VirtualDeltaModbusServer(("127.0.0.1", 0), memory=ModbusMemory())
        try:
            response, _summary = server.process_request_pdu(1, bytes.fromhex("03 FFFF 0002"))
        finally:
            server.server_close()

        self.assertEqual(response, bytes.fromhex("83 02"))

    def test_tcp_server_handles_modbus_adu(self):
        server = VirtualDeltaModbusServer(("127.0.0.1", 0), memory=ModbusMemory())
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()

        try:
            host, port = server.server_address
            with socket.create_connection((host, port), timeout=2) as sock:
                sock.sendall(mbap(7, 1, bytes.fromhex("06 0001 1234")))
                response = sock.recv(1024)
                self.assertEqual(response, mbap(7, 1, bytes.fromhex("06 0001 1234")))
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)


if __name__ == "__main__":
    unittest.main()
