import numpy as np

from pf_agent.trigger import LineTrigger, TriggerConfig, longest_run

FRAME_NS = 4_166_667  # 240 fps
rng = np.random.default_rng(7)


def water(n=360):
    """Garis air: biru kehijauan + riak acak kecil."""
    base = np.tile(np.array([120, 85, 35], np.float32), (n, 1))
    return np.clip(base + rng.normal(0, 6, (n, 3)), 0, 255).astype(np.uint8)


def with_boat(line, start, length, color=(40, 40, 210)):
    out = line.copy()
    out[start:start + length] = color
    return out


def test_longest_run():
    assert longest_run(np.array([0, 1, 1, 0, 1, 1, 1, 0], bool)) == 3
    assert longest_run(np.zeros(5, bool)) == 0


def test_memicu_saat_haluan_menyentuh_garis_dan_waktunya_frame_pertama():
    trig = LineTrigger()
    fired = []
    for i in range(200):
        line = water()
        if 100 <= i < 160:          # perahu melintas garis di frame 100–159
            line = with_boat(line, 80, 60)
        ts = i * FRAME_NS
        r = trig.update(ts, line)
        if r is not None:
            fired.append(r)
    assert fired == [100 * FRAME_NS]  # satu pemicu, dicap frame pertama perahu


def test_riak_dan_percikan_tersebar_tidak_memicu():
    trig = LineTrigger()
    for i in range(400):
        line = water()
        if i % 7 == 0:  # percikan: piksel acak tersebar ±10% garis
            idx = rng.choice(360, 36, replace=False)
            line[idx] = 255
        assert trig.update(i * FRAME_NS, line) is None


def test_dua_perahu_berdempetan_lalu_perahu_berikutnya_setelah_garis_bersih():
    trig = LineTrigger(TriggerConfig(release_s=0.5))
    fired = []
    for i in range(800):
        line = water()
        if 100 <= i < 160:
            line = with_boat(line, 60, 50)                    # perahu 1
        if 130 <= i < 200:
            line = with_boat(line, 220, 50, (30, 200, 240))   # perahu 2, berdempetan
        if 500 <= i < 560:
            line = with_boat(line, 150, 50)                   # perahu 3, jauh di belakang
        r = trig.update(i * FRAME_NS, line)
        if r is not None:
            fired.append(r // FRAME_NS)
    # Perahu 1&2 berdempetan = satu pemicu (keduanya masuk satu rekaman);
    # perahu 3 memicu lagi setelah garis bersih ≥ 0,5 dtk.
    assert fired == [100, 500]


def test_latar_beradaptasi_dengan_perubahan_cahaya_pelan():
    trig = LineTrigger()
    for i in range(1500):
        line = water().astype(np.float32) * (1 + i / 3000)  # makin terang pelan-pelan
        assert trig.update(i * FRAME_NS, np.clip(line, 0, 255).astype(np.uint8)) is None
