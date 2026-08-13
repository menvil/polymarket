#!/bin/bash
# Sweep TP x SL x dev x period
# Output: n / WR% / total per cell

cd /Users/menvil/Projects/polymarket/apps/bot

BASE="/Users/menvil/Projects/polymarket/apps/collect-data/snapshots"
DIRS_MAY16=$(for d in 01 02 03 04 05 06; do echo -n "${BASE}/2026-05-${d}/polymarket,"; done | sed 's/,$//')
DIRS_MAY713=$(for d in 07 08 09 10 11 12 13; do echo -n "${BASE}/2026-05-${d}/polymarket,"; done | sed 's/,$//')

TABLE="tables/edge-table-5min-apr-d10-t15-up.json"
CEX="tables/cex-cache"

DEVS=(5 10 15 20 25 30)
TPS=(5 10 15 20 25 30)
SLS=(5 10 15 20 25)

OUT_FILE="/tmp/sweep-tp-sl-dev-results.tsv"
echo -e "dev\tperiod\ttp\tsl\tn\twr\ttotal" > "$OUT_FILE"

extract_line() {
  local raw="$1"
  local line
  line=$(printf '%s' "$raw" | sed 's/\x1b\[[0-9;]*m//g' | grep "ВСЕ СДЕЛКИ" | head -1)
  local n wr total
  n=$(printf '%s' "$line" | sed -E 's/.*[^a-z]n= *([0-9]+).*/\1/')
  wr=$(printf '%s' "$line" | sed -E 's/.*win=([0-9.]+)%.*/\1/')
  total=$(printf '%s' "$line" | sed -E 's/.*total@\$10=([^ ]+).*/\1/')
  printf '%s/%s%%/%s' "$n" "$wr" "$total"
}

total_runs=$(( ${#DEVS[@]} * 2 * ${#TPS[@]} * ${#SLS[@]} ))
run=0

for dev in "${DEVS[@]}"; do
  for period_name in "May1-6" "May7-13"; do
    if [ "$period_name" = "May1-6" ]; then
      dirs="$DIRS_MAY16"
    else
      dirs="$DIRS_MAY713"
    fi

    echo ""
    echo "=============================="
    echo "dev=${dev}¢  ${period_name}"
    echo "=============================="
    printf "TP\\SL |"
    for sl in "${SLS[@]}"; do printf "    SL=%2s¢    |" "$sl"; done
    echo ""
    printf "------+"
    for sl in "${SLS[@]}"; do printf "-------------+"; done
    echo ""

    for tp in "${TPS[@]}"; do
      printf " TP=%2s¢|" "$tp"
      for sl in "${SLS[@]}"; do
        run=$((run + 1))
        out=$(npx tsx scripts/simulate-crowd-deviation-trades.ts \
          --table "$TABLE" \
          --snapshots "$dirs" \
          --cex-cache-dir "$CEX" \
          --asset bitcoin --token up \
          --min-entry-price 45 \
          --regime-filter up \
          --tp "$tp" --sl "$sl" \
          --entry-dev "$dev" 2>&1)
        cell=$(extract_line "$out")
        printf " %-12s|" "$cell"

        # extract parts for tsv
        n=$(printf '%s' "$out" | sed 's/\x1b\[[0-9;]*m//g' | grep "ВСЕ СДЕЛКИ" | head -1 | sed -E 's/.*[^a-z]n= *([0-9]+).*/\1/')
        wr=$(printf '%s' "$out" | sed 's/\x1b\[[0-9;]*m//g' | grep "ВСЕ СДЕЛКИ" | head -1 | sed -E 's/.*win=([0-9.]+)%.*/\1/')
        total=$(printf '%s' "$out" | sed 's/\x1b\[[0-9;]*m//g' | grep "ВСЕ СДЕЛКИ" | head -1 | sed -E 's/.*total@\$10=([^ ]+).*/\1/')
        echo -e "${dev}\t${period_name}\t${tp}\t${sl}\t${n}\t${wr}\t${total}" >> "$OUT_FILE"
      done
      echo ""
      echo "  [progress: ${run}/${total_runs}]"
    done
  done
done

echo ""
echo "=============================="
echo "DONE — results saved to $OUT_FILE"
echo "=============================="
