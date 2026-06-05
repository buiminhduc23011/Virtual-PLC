import unittest

from .virtual_plc_hub import VirtualPlcDevice, VirtualPlcManager, create_app


class VirtualPlcHubTests(unittest.TestCase):
    def test_manager_starts_with_one_default_plc(self):
        manager = VirtualPlcManager()
        self.addCleanup(manager.stop_all)

        devices = manager.list_devices()

        self.assertEqual(len(devices), 1)
        self.assertEqual(devices[0]["profileId"], "mitsubishi-fx3u")

    def test_manager_rejects_a_second_plc(self):
        manager = VirtualPlcManager(autostart_defaults=False)
        self.addCleanup(manager.stop_all)
        manager.create_device("FX", "mitsubishi-fx3u")

        with self.assertRaisesRegex(ValueError, "Only one virtual PLC"):
            manager.create_device("Q", "mitsubishi-q")

        self.assertEqual([device["name"] for device in manager.list_devices()], ["FX"])

    def test_profile_catalog_contains_required_plc_types(self):
        manager = VirtualPlcManager(autostart_defaults=False)
        profile_ids = {profile["id"] for profile in manager.list_profiles()}

        self.assertIn("mitsubishi-fx3u", profile_ids)
        self.assertIn("mitsubishi-q", profile_ids)
        self.assertIn("siemens-s7", profile_ids)
        self.assertIn("delta-dvp", profile_ids)
        self.assertIn("modbus-client", profile_ids)

    def test_mitsubishi_profile_round_trips_bit_and_word_cells(self):
        plc = VirtualPlcDevice("FX", "mitsubishi-fx3u", autostart=False)

        plc.write("M0", "Bool", True)
        plc.write("D0", "Int16", -123)

        self.assertEqual(plc.read("M0", "Bool"), True)
        self.assertEqual(plc.read("D0", "Int16"), -123)

    def test_siemens_db_round_trip(self):
        plc = VirtualPlcDevice("S7", "siemens-s7", autostart=False)

        plc.write("DB1.DBX0.2", "Bool", True)
        plc.write("DB1.DBW2", "Int16", 321)

        self.assertEqual(plc.read("DB1.DBX0.2", "Bool"), True)
        self.assertEqual(plc.read("DB1.DBW2", "Int16"), 321)

    def test_modbus_alias_round_trip(self):
        plc = VirtualPlcDevice("MB", "modbus-client", autostart=False)

        plc.write("C1", "Bool", True)
        plc.write("HR1", "UInt16", 1234)

        self.assertEqual(plc.read("C1", "Bool"), True)
        self.assertEqual(plc.read("HR1", "UInt16"), 1234)

    def test_delta_dvp_maps_d_register_to_modbus_holding_memory(self):
        plc = VirtualPlcDevice("DVP", "delta-dvp", autostart=False)

        plc.write("D0", "UInt16", 99)

        self.assertEqual(plc.read("D0", "UInt16"), 99)
        self.assertEqual(plc.modbus_memory.read_registers("holding_registers", 0x1000, 1), [99])

    def test_api_create_write_read_flow(self):
        app = create_app(autostart_defaults=False)
        client = app.test_client()

        create_response = client.post(
            "/api/plcs",
            json={"name": "Q_TEST", "profileId": "mitsubishi-q", "host": "127.0.0.1", "port": 5008},
        )
        self.assertEqual(create_response.status_code, 200)
        self.assertTrue(create_response.get_json()["success"])

        write_response = client.post(
            "/api/write",
            json={"plc": "Q_TEST", "address": "D0", "type": "UInt16", "value": 777},
        )
        self.assertEqual(write_response.status_code, 200)
        self.assertTrue(write_response.get_json()["success"])

        read_response = client.post(
            "/api/read",
            json={"plc": "Q_TEST", "address": "D0", "type": "UInt16"},
        )
        self.assertEqual(read_response.status_code, 200)
        self.assertEqual(read_response.get_json()["value"], 777)

        second_create_response = client.post(
            "/api/plcs",
            json={"name": "FX_TEST", "profileId": "mitsubishi-fx3u"},
        )
        self.assertEqual(second_create_response.status_code, 400)
        self.assertIn("Only one virtual PLC", second_create_response.get_json()["error"])
        self.assertEqual(len(client.get("/api/plcs").get_json()), 1)


if __name__ == "__main__":
    unittest.main()
