import tempfile
from pathlib import Path

from pf_agent import objfilter

# Filter objek menyimpan gambar keputusan. Thread filter di test bisa masih bekerja
# setelah test selesai, jadi folder dialihkan untuk SELURUH sesi test — bukan per test.
objfilter.DECISION_DIR = Path(tempfile.mkdtemp(prefix="pf-filter-log-"))
