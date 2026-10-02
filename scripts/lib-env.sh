# Pembaca .env yang aman untuk skrip bash (dipakai lewat `source`).
#
# JANGAN `source .env` langsung: nilai seperti connection string Atlas berisi
# `&` (…?tls=true&replicaSet=…) yang oleh bash dianggap operator "jalankan di
# latar", sehingga nilainya terpotong. Fungsi ini membaca baris KEY=VALUE apa
# adanya, membuang tanda kutip pembungkus, lalu meng-export.
load_env() {
  local file=${1:-.env} line key val
  [ -f "$file" ] || return 1
  while IFS= read -r line || [ -n "$line" ]; do
    [[ $line =~ ^[[:space:]]*([A-Za-z_][A-Za-z0-9_]*)=(.*)$ ]] || continue
    key=${BASH_REMATCH[1]}
    val=${BASH_REMATCH[2]}
    val=${val%$'\r'}
    if [[ $val =~ ^\"(.*)\"[[:space:]]*$ ]] || [[ $val =~ ^\'(.*)\'[[:space:]]*$ ]]; then
      val=${BASH_REMATCH[1]}
    fi
    export "$key=$val"
  done < "$file"
}
