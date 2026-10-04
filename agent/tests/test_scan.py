from pf_agent.scan import camera_kind


def test_jenis_kamera_dari_nama_dan_model():
    assert camera_kind("Rizkybor13 Camera", "iPhone14,5") == "iphone"
    assert camera_kind("FaceTime HD Camera", "FaceTime HD Camera") == "laptop"
    assert camera_kind("MacBook Pro Camera", "Built-in Camera") == "laptop"
    assert camera_kind("Logitech BRIO", "UVC Camera VendorID_1133") == "external"
