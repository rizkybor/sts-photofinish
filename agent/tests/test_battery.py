from pf_agent.battery import parse_pmset


def test_baterai_laptop_dari_pmset():
    out = "Now drawing from 'Battery Power'\n -InternalBattery-0 (id=25362531)\t18%; discharging; 0:35 remaining present: true\n"
    assert parse_pmset(out) == {"percent": 18, "charging": False}
    out = "Now drawing from 'AC Power'\n -InternalBattery-0 (id=1)\t64%; charging; 1:10 remaining present: true\n"
    assert parse_pmset(out) == {"percent": 64, "charging": True}
    out = "Now drawing from 'AC Power'\n -InternalBattery-0 (id=1)\t100%; charged; 0:00 remaining present: true\n"
    assert parse_pmset(out)["charging"] is True
    assert parse_pmset("Now drawing from 'AC Power'\n") is None  # desktop tanpa baterai
