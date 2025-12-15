from flask import Flask, render_template, request, jsonify
from flask_cors import CORS
from snap7.util import set_int, set_real, set_bool, get_int, get_real, get_bool
from snap7.server import Server
from snap7.type import SrvArea, WordLen
import threading
import time
import struct

app = Flask(__name__)
CORS(app)  # Enable CORS for Electron app

# ==== PLC Ảo Cấu Hình ====
class VirtualPLC:
    def __init__(self, name, db_config: dict[int, int], port: int, ip: str = "0.0.0.0"):
        self.name = name
        self.port = port
        self.ip = ip
        self.server = Server()
        self.db_buffers = {}
        self.db_config = db_config
        self.running = False

        for db_num, db_size in db_config.items():
            buf = (WordLen.Byte.ctype * db_size)()
            self.server.register_area(SrvArea.DB, db_num, buf)
            self.db_buffers[db_num] = buf
            print(f"[{self.name}] Registered DB{db_num} - {db_size} bytes")

    def start(self):
        print(f"[{self.name}] Starting on port {self.port}")
        self.server.start(tcp_port=self.port)
        self.running = True
        while self.running:
            event = self.server.pick_event()
            if event:
                print(f"[{self.name}] Event: {self.server.event_text(event)}")
            time.sleep(0.1)

    def stop(self):
        self.running = False
        self.server.stop()

    def get_info(self):
        return {
            "name": self.name,
            "ip": self.ip,
            "port": self.port,
            "dataBlocks": [{"dbNumber": db, "size": size} for db, size in self.db_config.items()]
        }

    # ==== Write Methods ====
    def write_int(self, db_number: int, byte_index: int, value: int):
        buf = self.db_buffers.get(db_number)
        if buf:
            set_int(buf, byte_index, value)
            return True
        return False

    def write_real(self, db_number: int, byte_index: int, value: float):
        buf = self.db_buffers.get(db_number)
        if buf:
            set_real(buf, byte_index, value)
            return True
        return False

    def write_bool(self, db_number: int, byte_index: int, bit_index: int, value: bool):
        buf = self.db_buffers.get(db_number)
        if buf:
            set_bool(buf, byte_index, bit_index, value)
            return True
        return False

    def write_byte(self, db_number: int, byte_index: int, value: int):
        buf = self.db_buffers.get(db_number)
        if buf and byte_index < len(buf):
            buf[byte_index] = value & 0xFF
            return True
        return False

    def write_word(self, db_number: int, byte_index: int, value: int):
        buf = self.db_buffers.get(db_number)
        if buf and byte_index + 1 < len(buf):
            struct.pack_into('>H', buf, byte_index, value & 0xFFFF)
            return True
        return False

    def write_dword(self, db_number: int, byte_index: int, value: int):
        buf = self.db_buffers.get(db_number)
        if buf and byte_index + 3 < len(buf):
            struct.pack_into('>I', buf, byte_index, value & 0xFFFFFFFF)
            return True
        return False

    def write_dint(self, db_number: int, byte_index: int, value: int):
        buf = self.db_buffers.get(db_number)
        if buf and byte_index + 3 < len(buf):
            struct.pack_into('>i', buf, byte_index, value)
            return True
        return False

    def write_string(self, db_number: int, byte_index: int, value: str, max_len: int = 254):
        buf = self.db_buffers.get(db_number)
        if buf:
            actual_len = min(len(value), max_len)
            buf[byte_index] = max_len
            buf[byte_index + 1] = actual_len
            for i, char in enumerate(value[:actual_len]):
                buf[byte_index + 2 + i] = ord(char)
            return True
        return False

    # ==== Read Methods ====
    def read_int(self, db_number: int, byte_index: int):
        buf = self.db_buffers.get(db_number)
        if buf:
            return get_int(buf, byte_index)
        return None

    def read_real(self, db_number: int, byte_index: int):
        buf = self.db_buffers.get(db_number)
        if buf:
            return get_real(buf, byte_index)
        return None

    def read_bool(self, db_number: int, byte_index: int, bit_index: int):
        buf = self.db_buffers.get(db_number)
        if buf:
            return get_bool(buf, byte_index, bit_index)
        return None

    def read_byte(self, db_number: int, byte_index: int):
        buf = self.db_buffers.get(db_number)
        if buf and byte_index < len(buf):
            return buf[byte_index]
        return None

    def read_word(self, db_number: int, byte_index: int):
        buf = self.db_buffers.get(db_number)
        if buf and byte_index + 1 < len(buf):
            return struct.unpack_from('>H', buf, byte_index)[0]
        return None

    def read_dword(self, db_number: int, byte_index: int):
        buf = self.db_buffers.get(db_number)
        if buf and byte_index + 3 < len(buf):
            return struct.unpack_from('>I', buf, byte_index)[0]
        return None

    def read_dint(self, db_number: int, byte_index: int):
        buf = self.db_buffers.get(db_number)
        if buf and byte_index + 3 < len(buf):
            return struct.unpack_from('>i', buf, byte_index)[0]
        return None

    def read_string(self, db_number: int, byte_index: int):
        buf = self.db_buffers.get(db_number)
        if buf:
            actual_len = buf[byte_index + 1]
            chars = [chr(buf[byte_index + 2 + i]) for i in range(actual_len)]
            return ''.join(chars)
        return None


# ==== Khởi tạo PLC ảo ====
plc_instances = {}

db_config = {
    1: 2000, 2: 2000, 3: 2000, 4: 2000, 5: 2000,
    6: 2000, 7: 2000, 8: 2000, 9: 2000, 10: 2000,
    11: 2000, 12: 2000, 13: 2000, 14: 2000, 15: 2000,
    16: 2000, 17: 2000, 18: 2000, 19: 2000, 20: 2000,
    21: 2000, 22: 2000, 23: 2000, 24: 2000, 25: 2000,
    26: 2000, 27: 2000, 28: 2000, 48: 2000,
}

plc1 = VirtualPLC("PLC_1", db_config, 1102, "127.0.0.1")
plc_instances["PLC_1"] = plc1
plc_thread = threading.Thread(target=plc1.start, daemon=True)
plc_thread.start()

plc2 = VirtualPLC("PLC_2", db_config, 1103, "127.0.0.1")
plc_instances["PLC_2"] = plc2
plc_thread2 = threading.Thread(target=plc2.start, daemon=True)
plc_thread2.start()


# ==== Flask API ====
def get_plc(plc_name: str):
    return plc_instances.get(plc_name)


@app.route('/')
def index():
    return render_template("UI.html")


@app.route('/api/plcs', methods=['GET'])
def get_all_plcs():
    """Get list of all PLCs with their info"""
    result = [plc.get_info() for plc in plc_instances.values()]
    return jsonify(result)


@app.route('/api/plc/<plc_name>/dbs', methods=['GET'])
def get_plc_dbs(plc_name):
    """Get all data blocks for a PLC"""
    plc = get_plc(plc_name)
    if not plc:
        return jsonify({'error': 'PLC not found'}), 404
    return jsonify([{"dbNumber": db, "size": size} for db, size in plc.db_config.items()])


@app.route('/api/read', methods=['POST'])
def read_value():
    """Read a single value from PLC"""
    data = request.get_json()
    plc_name = data.get('plc', 'PLC_1')
    db_number = data.get('db')
    offset = data.get('offset')
    data_type = data.get('type', 'INT').upper()
    bit_offset = data.get('bit', 0)

    plc = get_plc(plc_name)
    if not plc:
        return jsonify({'error': 'PLC not found'}), 404

    value = None
    try:
        if data_type == 'BOOL':
            value = plc.read_bool(db_number, offset, bit_offset)
        elif data_type == 'BYTE':
            value = plc.read_byte(db_number, offset)
        elif data_type == 'WORD':
            value = plc.read_word(db_number, offset)
        elif data_type == 'DWORD':
            value = plc.read_dword(db_number, offset)
        elif data_type == 'INT':
            value = plc.read_int(db_number, offset)
        elif data_type == 'DINT':
            value = plc.read_dint(db_number, offset)
        elif data_type == 'REAL':
            value = plc.read_real(db_number, offset)
        elif data_type == 'STRING':
            value = plc.read_string(db_number, offset)
    except Exception as e:
        return jsonify({'error': str(e)}), 500

    return jsonify({'value': value})


@app.route('/api/read/batch', methods=['POST'])
def read_batch():
    """Read multiple values at once"""
    data = request.get_json()
    plc_name = data.get('plc', 'PLC_1')
    addresses = data.get('addresses', [])

    plc = get_plc(plc_name)
    if not plc:
        return jsonify({'error': 'PLC not found'}), 404

    results = []
    for addr in addresses:
        db_number = addr.get('db')
        offset = addr.get('offset')
        data_type = addr.get('type', 'INT').upper()
        bit_offset = addr.get('bit', 0)

        value = None
        try:
            if data_type == 'BOOL':
                value = plc.read_bool(db_number, offset, bit_offset)
            elif data_type == 'BYTE':
                value = plc.read_byte(db_number, offset)
            elif data_type == 'WORD':
                value = plc.read_word(db_number, offset)
            elif data_type == 'DWORD':
                value = plc.read_dword(db_number, offset)
            elif data_type == 'INT':
                value = plc.read_int(db_number, offset)
            elif data_type == 'DINT':
                value = plc.read_dint(db_number, offset)
            elif data_type == 'REAL':
                value = plc.read_real(db_number, offset)
            elif data_type == 'STRING':
                value = plc.read_string(db_number, offset)
        except:
            pass

        results.append({**addr, 'value': value})

    return jsonify(results)


@app.route('/api/write', methods=['POST'])
def write_value():
    """Write a single value to PLC"""
    data = request.get_json()
    plc_name = data.get('plc', 'PLC_1')
    db_number = data.get('db')
    offset = data.get('offset')
    data_type = data.get('type', 'INT').upper()
    value = data.get('value')
    bit_offset = data.get('bit', 0)

    plc = get_plc(plc_name)
    if not plc:
        return jsonify({'success': False, 'error': 'PLC not found'}), 404

    success = False
    try:
        if data_type == 'BOOL':
            bool_val = value in [True, 'true', 'True', '1', 1]
            success = plc.write_bool(db_number, offset, bit_offset, bool_val)
        elif data_type == 'BYTE':
            success = plc.write_byte(db_number, offset, int(value))
        elif data_type == 'WORD':
            success = plc.write_word(db_number, offset, int(value))
        elif data_type == 'DWORD':
            success = plc.write_dword(db_number, offset, int(value))
        elif data_type == 'INT':
            success = plc.write_int(db_number, offset, int(value))
        elif data_type == 'DINT':
            success = plc.write_dint(db_number, offset, int(value))
        elif data_type == 'REAL':
            success = plc.write_real(db_number, offset, float(value))
        elif data_type == 'STRING':
            success = plc.write_string(db_number, offset, str(value))
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500

    return jsonify({'success': success})


# Legacy endpoint for compatibility
@app.route('/write', methods=['POST'])
def write_legacy():
    plc_target = request.args.get('plc', 'plc1')
    target_plc = plc1 if plc_target == 'plc1' else plc2 if plc_target == 'plc2' else None
    if not target_plc:
        return jsonify({'message': '❌ Không tìm thấy PLC'}), 400

    data = request.get_json()
    for item in data:
        value = item['value']
        address = item['address']
        type_ = item['type']

        try:
            db_part, addr_part = address.split(',')
            db_num = int(db_part.replace('DB', ''))
            
            if 'INT' in addr_part:
                byte_index = int(addr_part.replace('INT', ''))
                target_plc.write_int(db_num, byte_index, int(value))
            elif 'REAL' in addr_part:
                byte_index = int(addr_part.replace('REAL', ''))
                target_plc.write_real(db_num, byte_index, float(value))
            elif 'X' in addr_part:
                parts = addr_part.replace('X', '').split('.')
                target_plc.write_bool(db_num, int(parts[0]), int(parts[1]), value.lower() == 'true')
        except Exception as e:
            print(f"[ERROR] Lỗi tại {address}: {e}")
            return jsonify({'message': f'Lỗi tại {address}: {e}'}), 500

    return jsonify({'message': f'✅ Ghi vào {plc_target.upper()} thành công!'})


if __name__ == '__main__':
    print("=" * 50)
    print("Virtual PLC S7 Server")
    print("=" * 50)
    print(f"PLC_1: 127.0.0.1:{plc1.port}")
    print(f"PLC_2: 127.0.0.1:{plc2.port}")
    print(f"API Server: http://localhost:5000")
    print("=" * 50)
    app.run(host='0.0.0.0', port=5000, debug=False)
