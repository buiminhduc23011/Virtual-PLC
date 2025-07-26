from flask import Flask, render_template, request, jsonify
from snap7.util import set_int, set_real, set_bool
from snap7.server import Server
from snap7.type import SrvArea, WordLen
import threading
import time

app = Flask(__name__)

# ==== PLC Ảo Cấu Hình ====
class VirtualPLC:
    def __init__(self, name, db_config: dict[int, int], port: int):
        self.name = name
        self.port = port
        self.server = Server()
        self.db_buffers = {}
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

    def write_int(self, db_number: int, byte_index: int, value: int):
        buf = self.db_buffers.get(db_number)
        if buf:
            set_int(buf, byte_index, value)

    def write_real(self, db_number: int, byte_index: int, value: float):
        buf = self.db_buffers.get(db_number)
        if buf:
            set_real(buf, byte_index, value)

    def write_bool(self, db_number: int, byte_index: int, bit_index: int, value: bool):
        buf = self.db_buffers.get(db_number)
        if buf:
            set_bool(buf, byte_index, bit_index, value)


# ==== Khởi tạo PLC ảo ====
db_config = {
    1: 2000,2: 2000,
    3: 2000,4: 2000,
    5: 2000,6: 2000,
    7: 2000,8: 2000,
    9: 2000,10: 2000,
    11: 2000,12: 2000,
    13: 2000,14: 2000,
    15: 2000,16: 2000,
    17: 2000,18: 2000,
    19: 2000,20: 2000,
    21: 2000,22: 2000,
    23: 2000,24: 2000,
    25: 2000,26: 2000,
    27: 2000,28: 2000,
    48: 2000,
}
plc1 = VirtualPLC("PLC_1", db_config, 1102) #IP máy tính PLC1 Port là 1102, PLC 2 sẽ là 1103
plc_thread = threading.Thread(target=plc1.start)
plc_thread.start()

# PLC 2
plc2 = VirtualPLC("PLC_2", db_config, 1103)
plc_thread2 = threading.Thread(target=plc2.start)
plc_thread2.start()

# ==== Flask API để nhận từ Web ====
def parse_address(address: str):
    try:
        db_part, addr_part = address.split(',')
        db_num = int(db_part.replace('DB', ''))
        if 'INT' in addr_part:
            byte_index = int(addr_part.replace('INT', ''))
            return db_num, byte_index, 'int'
        elif 'REAL' in addr_part:
            byte_index = int(addr_part.replace('REAL', ''))
            return db_num, byte_index, 'real'
        elif 'X' in addr_part:
            parts = addr_part.replace('X', '').split('.')
            return db_num, (int(parts[0]), int(parts[1])), 'bool'
    except:
        return None, None, None

@app.route('/')
def index():
    return render_template("UI.html")

@app.route('/write', methods=['POST'])
def write():
    plc_target = request.args.get('plc', 'plc1')  # lấy từ URL: ?plc=plc1

    # Chọn đúng PLC
    target_plc = plc1 if plc_target == 'plc1' else plc2 if plc_target == 'plc2' else None
    if not target_plc:
        return jsonify({'message': '❌ Không tìm thấy PLC'}), 400

    data = request.get_json()
    for item in data:
        value = item['value']
        address = item['address']
        type_ = item['type']

        db, offset, inferred = parse_address(address)
        if db is None:
            continue

        try:
            if type_ == 'int':
                target_plc.write_int(db, offset, int(value))
            elif type_ == 'real':
                target_plc.write_real(db, offset, float(value))
            elif type_ == 'bool':
                byte_index, bit_index = offset
                target_plc.write_bool(db, byte_index, bit_index, value.lower() == 'true')
        except Exception as e:
            print(f"[ERROR] Lỗi tại {address}: {e}")
            return jsonify({'message': f'Lỗi tại {address}: {e}'}), 500

    return jsonify({'message': f'✅ Ghi vào {plc_target.upper()} thành công!'})


if __name__ == '__main__':
    app.run(port=5000)
