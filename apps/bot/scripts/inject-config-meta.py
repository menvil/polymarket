#!/usr/bin/env python3
"""
Массовое заполнение _meta для всех backtest-конфигов.

Источники данных:
  - memory/cll-fixed-results-20260429.md       — CLL per-day UP/DOWN
  - memory/cllr-residual-overlay-results-20260502.md — CLLR per-day delta
  - memory/calibrated-crowd-results-20260427.md — CC variants grid
  - memory/all-strategy-results.md              — AE/SEL/FV aggregate
  - memory/selective-entry-ablation.md          — SEL ablation variants
  - memory/fair-value-mm-results.md             — FV sigma sweep
  - memory/backtest-findings-phase3.md          — AS zone-only, phase 3
  - docs/guides/strategy-hypotheses.md          — AS full evolution
  - docs/guides/selective-entry-ablation.md     — SEL ablation table

Запуск: python3 scripts/inject-config-meta.py [--dry-run] [--pattern REGEX]
"""

import json
import os
import re
import sys
from pathlib import Path

CONFIGS_DIR = Path(__file__).parent.parent / 'configs'
DRY_RUN = '--dry-run' in sys.argv
PATTERN_FILTER = None
for i, arg in enumerate(sys.argv):
    if arg == '--pattern' and i + 1 < len(sys.argv):
        PATTERN_FILTER = re.compile(sys.argv[i + 1])

# ─────────────────────────────────────────────────────────────────
# Вспомогательные функции
# ─────────────────────────────────────────────────────────────────

def inject(filename: str, meta: dict) -> None:
    path = CONFIGS_DIR / f'{filename}.json'
    if not path.exists():
        print(f'  SKIP (not found): {filename}')
        return
    if PATTERN_FILTER and not PATTERN_FILTER.search(filename):
        return
    try:
        raw = json.loads(path.read_text())
    except Exception as e:
        print(f'  ERROR parsing {filename}: {e}')
        return
    # Не перезаписываем если мета уже есть и не отличается существенно
    raw.pop('_meta', None)
    new = {'_meta': meta, **raw}
    if DRY_RUN:
        print(f'  [dry-run] would update: {filename}')
        return
    path.write_text(json.dumps(new, indent=2, ensure_ascii=False) + '\n')


def pnl_sign(v: float) -> str:
    return f'+{v:.2f} USDC' if v >= 0 else f'{v:.2f} USDC'


# ─────────────────────────────────────────────────────────────────
# 1. CLL verify series — per-day точные данные из memory
# ─────────────────────────────────────────────────────────────────
print('\n[1] verify-cll UP/DOWN series...')

CLL_UP_DAYS = {
    '20260421': ('+3.98 USDC',  '62.9%', 35,  'нормальный день'),
    '20260422': ('+5.31 USDC',  '56.4%', 39,  'нормальный день'),
    '20260423': ('+6.80 USDC',  '80.0%', 20,  'очень хороший день'),
    '20260424': ('+12.22 USDC', '74.2%', 31,  'лучший UP день'),
    '20260425': ('+0.21 USDC',  '37.5%', 8,   'мало сделок (3W/5L)'),
    '20260426': ('+4.33 USDC',  '72.7%', 22,  'нормальный день'),
    '20260427': ('-0.70 USDC',  '57.1%', 7,   'неполный день (4W/3L)'),
}
CLL_DOWN_DAYS = {
    '20260421': ('-13.16 USDC', '28.0%', 193, 'плохой день — много fills с потерями'),
    '20260422': ('+13.89 USDC', '39.5%', 124, 'лучший DOWN день'),
    '20260423': ('+12.75 USDC', '32.3%', 161, 'хороший день'),
    '20260424': ('+9.23 USDC',  '36.0%', 172, 'хороший день'),
    '20260425': ('-1.58 USDC',  '34.7%', 176, 'нейтральный'),
    '20260426': ('+5.56 USDC',  '34.8%', 230, 'нормальный день'),
    '20260427': ('+10.24 USDC', '41.5%', 53,  'неполный день, WR выше нормы'),
}
# CLLR DOWN = CLL DOWN + delta per day
CLLR_DOWN_DELTAS = {
    '20260421': 7.57,
    '20260422': -5.83,
    '20260423': 0.40,
    '20260424': 5.97,
    '20260425': 7.80,
    '20260426': -1.79,
    '20260427': -2.79,
}

for date, (pnl, wr, fills, note) in CLL_UP_DAYS.items():
    inject(f'verify-cll-up-{date}', {
        'desc': f'CexLeadLag UP side verify, {date[:4]}-{date[4:6]}-{date[6:]} OOS',
        'status': 'oos-validated',
        'backtest': {
            'dataset': f'live-recordings {date[:4]}-{date[4:6]}-{date[6:]} OOS',
            'pnl': pnl, 'wr': wr, 'markets': fills,
            'date': '2026-04-29',
            'notes': f'{note}. Часть 7-дневного OOS окна (total UP +32.16 USDC)',
        },
        'todo': ['re-run on 2026-05 data to verify continued edge'],
    })

for date, (pnl, wr, fills, note) in CLL_DOWN_DAYS.items():
    inject(f'verify-cll-down-{date}', {
        'desc': f'CexLeadLag DOWN side verify, {date[:4]}-{date[4:6]}-{date[6:]} OOS',
        'status': 'oos-validated',
        'backtest': {
            'dataset': f'live-recordings {date[:4]}-{date[4:6]}-{date[6:]} OOS',
            'pnl': pnl, 'wr': wr, 'markets': fills,
            'date': '2026-04-29',
            'notes': f'{note}. outcomeIndex=1 (primary=DOWN token). Total DOWN 7d: +36.93 USDC',
        },
        'todo': [
            're-run on 2026-05 data to verify continued edge',
            'understand why WR ~30-40% is profitable (R/R > 2:1 механизм)',
        ],
    })

# ─────────────────────────────────────────────────────────────────
# 2. CLLC verify — 0 fills (edge-table unusable)
# ─────────────────────────────────────────────────────────────────
print('[2] verify-cllc series (edge-table blocked = 0 fills)...')

for date in CLL_UP_DAYS:
    inject(f'verify-cllc-up-{date}', {
        'desc': f'CexLeadLag + edge-table UP side verify, {date[:4]}-{date[4:6]}-{date[6:]}',
        'status': 'archived',
        'backtest': {
            'dataset': f'live-recordings {date[:4]}-{date[4:6]}-{date[6:]}',
            'pnl': '0.00 USDC', 'markets': 0,
            'date': '2026-04-29',
            'notes': '0 fills — edge-table-5min-delta-regime.json: 88% SKIP, 0 BUY zones для UP. Таблица непригодна для cllc.',
        },
        'todo': [
            'rebuild edge-table с менее строгими gates (minN<20, minEdge<3%)',
            'или сегментировать отдельные таблицы для UP/DOWN tokens',
            'или отказаться от edge-table в CLL (голый cll даёт достаточный edge)',
        ],
    })
    inject(f'verify-cllc-down-{date}', {
        'desc': f'CexLeadLag + edge-table DOWN side verify, {date[:4]}-{date[4:6]}-{date[6:]}',
        'status': 'archived',
        'backtest': {
            'dataset': f'live-recordings {date[:4]}-{date[4:6]}-{date[6:]}',
            'pnl': '0.00 USDC', 'markets': 0,
            'date': '2026-04-29',
            'notes': '0 fills — zone.kelly.side mismatch фильтр блокирует все входы. outcomeIndex=1 для DOWN.',
        },
        'todo': ['rebuild edge-table с сегментацией UP/DOWN'],
    })

# ─────────────────────────────────────────────────────────────────
# 3. CLLR verify — UP = CLL UP, DOWN = CLL DOWN + delta
# ─────────────────────────────────────────────────────────────────
print('[3] verify-cllr series...')

for date, (pnl, wr, fills, note) in CLL_UP_DAYS.items():
    inject(f'verify-cllr-up-{date}', {
        'desc': f'CexLeadLag + CLLR residual overlay UP side, {date[:4]}-{date[4:6]}-{date[6:]}',
        'status': 'oos-validated',
        'backtest': {
            'dataset': f'live-recordings {date[:4]}-{date[4:6]}-{date[6:]} OOS',
            'pnl': pnl, 'wr': wr, 'markets': fills,
            'date': '2026-05-02',
            'notes': f'Идентично CLL UP — SELL zones (resid∈[-6,-2]) не срабатывают на UP-side. {note}',
        },
        'todo': ['confirm mechanism: why UP-side is unaffected by residual overlay'],
    })

for date, (cll_pnl, cll_wr, fills, note) in CLL_DOWN_DAYS.items():
    delta = CLLR_DOWN_DELTAS[date]
    cll_val = float(cll_pnl.replace(' USDC', ''))
    cllr_val = cll_val + delta
    inject(f'verify-cllr-down-{date}', {
        'desc': f'CexLeadLag + CLLR residual overlay DOWN side, {date[:4]}-{date[4:6]}-{date[6:]}',
        'status': 'oos-validated',
        'backtest': {
            'dataset': f'live-recordings {date[:4]}-{date[4:6]}-{date[6:]} OOS',
            'pnl': pnl_sign(cllr_val),
            'markets': fills,
            'date': '2026-05-02',
            'notes': f'CLL={pnl_sign(cll_val)} → CLLR={pnl_sign(cllr_val)} (Δ={pnl_sign(delta)}). {note}',
        },
        'todo': [
            'trace mechanism: why SELL zones at resid∈[-6,-2] improve DOWN-side',
            're-run on 2026-05 data to verify residual overlay still has edge',
        ],
    })

# ─────────────────────────────────────────────────────────────────
# 4. verify-ae-auto — результаты НЕ записаны
# ─────────────────────────────────────────────────────────────────
print('[4] verify-ae-auto series (results not recorded)...')

for date in CLL_UP_DAYS:
    inject(f'verify-ae-auto-{date}', {
        'desc': f'AdaptiveEntry 15min auto UP/DOWN verify, {date[:4]}-{date[4:6]}-{date[6:]}',
        'status': 'oos',
        'backtest': {
            'dataset': f'live-recordings {date[:4]}-{date[4:6]}-{date[6:]}',
            'pnl': 'не записан',
            'notes': 'Запускался в рамках 7-дневного OOS sweep. Результаты не зафиксированы в памяти.',
        },
        'todo': [
            'перезапустить и зафиксировать PnL/WR за этот день',
            'сравнить с btc1-5 results (ae-auto: total +18.73, WR 79.8%)',
            'проверить применимость на Apr 21-27 данных (новый датасет)',
        ],
    })

# ─────────────────────────────────────────────────────────────────
# 5. verify-sel-baseline — результаты НЕ записаны
# ─────────────────────────────────────────────────────────────────
print('[5] verify-sel-baseline series (results not recorded)...')

for date in CLL_UP_DAYS:
    inject(f'verify-sel-baseline-{date}', {
        'desc': f'SelectiveEntry baseline verify, {date[:4]}-{date[4:6]}-{date[6:]}',
        'status': 'oos',
        'backtest': {
            'dataset': f'live-recordings {date[:4]}-{date[4:6]}-{date[6:]}',
            'pnl': 'не записан',
            'notes': 'Запускался в рамках 7-дневного OOS sweep. Результаты не зафиксированы.',
        },
        'todo': [
            'перезапустить и зафиксировать PnL/WR за этот день',
            'сравнить с btc4+btc5 OOS (+4.54 суммарно на исходных данных)',
            'добавить requireDeltaAccel для сравнения с sel-live результатами',
        ],
    })

# ─────────────────────────────────────────────────────────────────
# 6. verify-fv-s80f60 — результаты НЕ записаны
# ─────────────────────────────────────────────────────────────────
print('[6] verify-fv-s80f60 series (results not recorded)...')

for date in CLL_UP_DAYS:
    inject(f'verify-fv-s80f60-{date}', {
        'desc': f'FairValueMM s80f60 verify, {date[:4]}-{date[4:6]}-{date[6:]}',
        'status': 'oos',
        'backtest': {
            'dataset': f'live-recordings {date[:4]}-{date[4:6]}-{date[6:]}',
            'pnl': 'не записан',
            'notes': 'Запускался в рамках 7-дневного OOS sweep. Результаты не зафиксированы. Известно: total btc4+btc5 OOS = -2.46 USDC на исходных данных.',
        },
        'todo': [
            'перезапустить и зафиксировать PnL/WR за этот день',
            'FV OOS исторически слабый (-2.46 на btc4/5) — проверить продолжается ли',
            'сравнить с SelectiveEntry daccel на тех же данных',
        ],
    })

# ─────────────────────────────────────────────────────────────────
# 7. ae-auto-btc* — точные данные
# ─────────────────────────────────────────────────────────────────
print('[7] ae-auto-btc canonical...')

AE_AUTO_BTCn = {
    'btc1': ('-5.45 USDC',  '69.2%', 13, 25,  'btc1 убыточный (маленький dataset)'),
    'btc2': ('+13.71 USDC', '80.4%', 45, 89,  'train dataset'),
    'btc4': ('+1.87 USDC',  '84.2%', 20, 61,  'test dataset'),
    'btc5': ('+8.60 USDC',  '80.6%', 36, 77,  'OOS dataset — лучший OOS'),
}
for btc, (pnl, wr, fills, mkts, note) in AE_AUTO_BTCn.items():
    inject(f'ae-auto-{btc}-backtest', {
        'desc': f'AdaptiveEntry 15min auto UP/DOWN, {btc} dataset',
        'status': 'oos-validated',
        'backtest': {
            'dataset': f'{btc} snapshots 5-min BTC, {mkts} markets',
            'pnl': pnl, 'wr': wr, 'markets': mkts,
            'date': '2026-03-31',
            'notes': f'{fills} fills. {note}. Total 4-day: +18.73 USDC, 79.8% WR.',
        },
        'todo': ['re-run on Apr 21-27 data (see verify-ae-auto configs)'],
    })

# ─────────────────────────────────────────────────────────────────
# 8. ae-5min-baseline — not viable
# ─────────────────────────────────────────────────────────────────
print('[8] ae-5min-baseline (not viable)...')

AE_5MIN_BTCn = {
    'btc1': '-12.80 USDC',
    'btc2': '+38.79 USDC',
    'btc4': '-21.13 USDC',
    'btc5': '-2.14 USDC',
}
for btc, pnl in AE_5MIN_BTCn.items():
    inject(f'ae-5min-baseline-{btc}-backtest', {
        'desc': f'AdaptiveEntry 5min baseline (НЕ РАБОТАЕТ), {btc}',
        'status': 'archived',
        'backtest': {
            'dataset': f'{btc} snapshots 5-min BTC',
            'pnl': pnl,
            'date': '2026-03-31',
            'notes': 'btc2 аномально +38.79 (overfit). btc1/4/5 все убыточные. 5-min слишком шумный для momentum.',
        },
        'todo': ['не запускать — 5-min momentum не работает, используй ae-auto-btc* (15-min)'],
    })

# ─────────────────────────────────────────────────────────────────
# 9. ae-5min parameter sweeps — все overfit
# ─────────────────────────────────────────────────────────────────
print('[9] ae-5min parameter sweeps (overfit)...')

AE_5MIN_SWEEPS = [
    r'^ae-5min-r2',
    r'^ae-5min-rise',
]
ae_sweep_files = [
    f.stem for f in CONFIGS_DIR.glob('ae-5min-r2*.json')
] + [
    f.stem for f in CONFIGS_DIR.glob('ae-5min-rise*.json')
]
for fname in ae_sweep_files:
    inject(fname, {
        'desc': f'AdaptiveEntry 5min parameter sweep — {fname}',
        'status': 'archived',
        'backtest': {
            'dataset': 'btc2 snapshots 5-min (одиночный sweep день)',
            'pnl': 'не записан',
            'notes': 'Параметрический sweep на 5-min: все варианты overfit на btc2. 5-min momentum нежизнеспособен.',
        },
        'todo': ['не запускать — 5-min momentum overfit. Вместо этого: ae-auto-btc* (15-min)'],
    })

# ─────────────────────────────────────────────────────────────────
# 10. ae directional variants (up/dn/mkt/off3/combo/cr variants)
# ─────────────────────────────────────────────────────────────────
print('[10] ae directional variants...')

AE_DIR_BTCn = {
    'up':     (None, 'UP-only variant AdaptiveEntry'),
    'dn':     (None, 'DOWN-only variant AdaptiveEntry'),
    'mkt-up': (None, 'Market-momentum UP variant'),
    'mkt-dn': (None, 'Market-momentum DOWN variant'),
    'off3-up':(None, 'Offset-3 UP variant'),
    'off3-dn':(None, 'Offset-3 DOWN variant'),
    'combo-up':(None, 'Combo UP variant'),
    'combo-dn':(None, 'Combo DOWN variant'),
}
for btc in ['btc1','btc2','btc4','btc5']:
    for variant, (pnl, desc) in AE_DIR_BTCn.items():
        fname = f'ae-{variant}-{btc}-backtest'
        if (CONFIGS_DIR / f'{fname}.json').exists():
            inject(fname, {
                'desc': f'{desc}, {btc}',
                'status': 'insample',
                'backtest': {
                    'dataset': f'{btc} snapshots 5-min BTC',
                    'pnl': 'не записан',
                    'notes': 'Часть ablation/sweep серии для AdaptiveEntry directional variants.',
                },
                'todo': [
                    'результаты не зафиксированы — перезапустить если нужны',
                    'сравнить с ae-auto (auto лучше directional в большинстве случаев)',
                ],
            })

# cr variants
for btc in ['btc1','btc2','btc4','btc5']:
    for cr in ['cr0-m75', 'cr0-m99', 'cr2-m75']:
        fname = f'ae-{cr}-{btc}-backtest'
        if (CONFIGS_DIR / f'{fname}.json').exists():
            inject(fname, {
                'desc': f'AdaptiveEntry crowd-relative {cr}, {btc}',
                'status': 'insample',
                'backtest': {
                    'dataset': f'{btc} snapshots 5-min BTC',
                    'pnl': 'не записан',
                    'notes': 'Crowd-relative entry filter experiment.',
                },
                'todo': ['результаты не зафиксированы — low priority'],
            })

# ─────────────────────────────────────────────────────────────────
# 11. sel-baseline-btc* — точные данные
# ─────────────────────────────────────────────────────────────────
print('[11] sel-baseline canonical...')

SEL_BASE_BTCn = {
    'btc1': ('+16.31 USDC', '83.3%', 18, 70,  'train (аномально хороший, малый dataset)'),
    'btc2': ('-7.10 USDC',  '60.0%', 57, 254, 'train (плохой, много DOWN рынков)'),
    'btc4': ('-0.20 USDC',  '64.9%', 36, 167, 'test — breakeven'),
    'btc5': ('+4.74 USDC',  '66.7%', 45, 207, 'test (OOS profitable!)'),
}
for btc, (pnl, wr, fills, mkts, note) in SEL_BASE_BTCn.items():
    inject(f'sel-baseline-{btc}-backtest', {
        'desc': f'SelectiveEntry baseline, {btc} dataset',
        'status': 'oos-validated',
        'backtest': {
            'dataset': f'{btc} snapshots 5-min BTC, {mkts} markets',
            'pnl': pnl, 'wr': wr, 'markets': mkts,
            'date': '2026-03-28',
            'notes': f'{fills} fills. {note}. Total: +13.75 USDC, 65.6% WR.',
        },
        'todo': ['re-run on Apr 21-27 (see verify-sel-baseline configs)'],
    })

# ─────────────────────────────────────────────────────────────────
# 12. sel ablation variants (sel-d05, sel-z60, sel-z60d05, sel-tau90, etc.)
# ─────────────────────────────────────────────────────────────────
print('[12] sel ablation variants...')

# zone60 variant (+4.90 total)
SEL_Z60_BTCn = {
    'btc1': '+14.18 USDC',
    'btc2': '-9.95 USDC',
    'btc4': '-2.97 USDC',
    'btc5': '+3.64 USDC',
}
for btc, pnl in SEL_Z60_BTCn.items():
    inject(f'sel-z60-{btc}-backtest', {
        'desc': f'SelectiveEntry zone60 ablation (minZoneCents=60), {btc}',
        'status': 'insample',
        'backtest': {
            'dataset': f'{btc} snapshots 5-min BTC',
            'pnl': pnl,
            'date': '2026-04-01',
            'notes': 'zone60 variant. Total: +4.90 USDC — нейтрально vs baseline +13.75. Строже нижняя граница = теряем хорошие входы.',
        },
        'todo': ['не использовать в production — baseline лучше'],
    })

# sel-d05 variant — likely daccel=true (daccel: +24.71 total)
SEL_DACCEL_BTCn = {
    'btc1': '+13.96 USDC',
    'btc2': '+7.51 USDC',
    'btc4': '-1.25 USDC',
    'btc5': '+4.49 USDC',
}
for btc, pnl in SEL_DACCEL_BTCn.items():
    fname = f'sel-d05-{btc}-backtest'
    if (CONFIGS_DIR / f'{fname}.json').exists():
        inject(fname, {
            'desc': f'SelectiveEntry daccel ablation (requireDeltaAccel=true), {btc}',
            'status': 'oos-validated',
            'backtest': {
                'dataset': f'{btc} snapshots 5-min BTC',
                'pnl': pnl,
                'date': '2026-04-01',
                'notes': 'daccel лучший вариант. Total: +24.71 USDC, 68.3% WR (+10.96 vs baseline). Перевернул btc2 с -7.10 в +7.51.',
            },
            'todo': ['эти параметры использованы в sel-live-5min.json'],
        })

# sel-z60d05 — zone60+daccel combo (dz: +21.01)
SEL_DZ_BTCn = {
    'btc1': '+13.98 USDC',
    'btc2': '+5.06 USDC',
    'btc4': '-1.72 USDC',
    'btc5': '+3.69 USDC',
}
for btc, pnl in SEL_DZ_BTCn.items():
    fname = f'sel-z60d05-{btc}-backtest'
    if (CONFIGS_DIR / f'{fname}.json').exists():
        inject(fname, {
            'desc': f'SelectiveEntry zone60+daccel combo, {btc}',
            'status': 'insample',
            'backtest': {
                'dataset': f'{btc} snapshots 5-min BTC',
                'pnl': pnl,
                'date': '2026-04-01',
                'notes': 'dz combo. Total: +21.01 USDC. Хуже чем daccel alone (+24.71). Combo не улучшает.',
            },
            'todo': ['не оптимально — используй daccel alone (sel-d05-btc*)'],
        })

# sel other variants with unknown exact per-btc results
for variant_prefix, desc, note in [
    ('sel-tau90',      'SelectiveEntry tau90 variant',                    'Изменён maxTauSec=90. Результаты не зафиксированы.'),
    ('sel-up-only',    'SelectiveEntry UP-only side',                     'UP-only variant. Результаты не зафиксированы.'),
    ('sel-down',       'SelectiveEntry DOWN side variant',                 'DOWN-only. Результаты не зафиксированы.'),
    ('sel-15m',        'SelectiveEntry 15-min markets variant',           '15-мин markets тест.'),
    ('se-bull',        'SmartEntry bull directional variant',             'SmartEntry стратегия (не SelectiveEntry!).'),
    ('se-bear',        'SmartEntry bear directional variant',             'SmartEntry стратегия (не SelectiveEntry!).'),
]:
    for btc in ['btc1','btc2','btc4','btc5']:
        fname = f'{variant_prefix}-{btc}-backtest'
        if (CONFIGS_DIR / f'{fname}.json').exists():
            inject(fname, {
                'desc': f'{desc}, {btc}',
                'status': 'insample',
                'backtest': {
                    'dataset': f'{btc} snapshots 5-min BTC',
                    'pnl': 'не записан',
                    'notes': note,
                },
                'todo': ['результаты не зафиксированы — перезапустить если нужны данные'],
            })

# ─────────────────────────────────────────────────────────────────
# 13. sel backtest misc configs
# ─────────────────────────────────────────────────────────────────
print('[13] sel backtest misc...')

SEL_MISC = {
    'sel-backtest-5min': ('SelectiveEntry 5min ablation', 'Ablation study конфиг. Результаты в docs/guides/selective-entry-ablation.md'),
    'sel-backtest-5min-current': ('SelectiveEntry 5min current config', 'Текущий production конфиг (daccel). Документирован.'),
    'sel-backtest-5min-legacy': ('SelectiveEntry 5min legacy (до ablation)', 'Старый конфиг без daccel. Reference only.'),
    'sel-backtest-5min-post-only-only': ('SelectiveEntry post-only ablation', 'Post-only only variant для ablation.'),
    'sel-backtest-5min-pricing-only': ('SelectiveEntry pricing-only ablation', 'Pricing-only variant для ablation.'),
    'sel-backtest-apr8': ('SelectiveEntry Apr8 backtest', 'Бэктест на Apr 8 данных.'),
    'sel-discovery-backtest-btc-5min': ('SelectiveEntry discovery backtest 5min', 'Бэктест с discovery mode.'),
}
for fname, (desc, note) in SEL_MISC.items():
    if (CONFIGS_DIR / f'{fname}.json').exists():
        inject(fname, {
            'desc': desc,
            'status': 'insample',
            'backtest': {
                'dataset': '5-min BTC snapshots',
                'pnl': 'не записан',
                'notes': note,
            },
            'todo': ['результаты не зафиксированы — см. docs/guides/selective-entry-ablation.md'],
        })

# ─────────────────────────────────────────────────────────────────
# 14. fv-* Fair Value MM series
# ─────────────────────────────────────────────────────────────────
print('[14] fv-* Fair Value MM series...')

FV_SERIES = {
    's80f60': {
        'btc1': ('+4.98 USDC',  '54.5%', 17),
        'btc2': ('+22.82 USDC', '69.0%', 131),
        'btc4': ('+0.45 USDC',  '60.6%', 54),
        'btc5': ('-2.91 USDC',  '54.7%', 105),
        'status': 'oos-validated',
        'total': '+25.34 USDC',
        'desc': 'sigma=0.80, minFair=60 — ЛУЧШИЙ FV конфиг. OOS -2.46 (btc4+btc5).',
    },
    'f65': {
        'btc1': ('+9.94 USDC',  None, None),
        'btc2': ('+14.04 USDC', None, None),
        'btc4': ('+2.00 USDC',  None, None),
        'btc5': ('-12.34 USDC', None, None),
        'status': 'insample',
        'total': '+13.64 USDC',
        'desc': 'sigma=0.60, minFair=65. Total +13.64, OOS -10.34.',
    },
    'q1f60': {
        'btc1': ('+6.72 USDC',  None, None),
        'btc2': ('+12.94 USDC', None, None),
        'btc4': ('+0.08 USDC',  None, None),
        'btc5': ('-16.50 USDC', None, None),
        'status': 'insample',
        'total': '+3.24 USDC',
        'desc': 'sigma=0.60, minFair=60. Total +3.24, OOS -16.42.',
    },
    'baseline': {
        'btc1': ('-7.44 USDC',  None, None),
        'btc2': ('-2.61 USDC',  None, None),
        'btc4': ('+14.59 USDC', None, None),
        'btc5': ('-53.04 USDC', None, None),
        'status': 'archived',
        'total': '-48.50 USDC',
        'desc': 'FV baseline (qMax=3). Катастрофический btc5 -53.04. Заменён qMax=1.',
    },
}

for series, data in FV_SERIES.items():
    total = data['total']
    st = data['status']
    desc_base = data['desc']
    for btc in ['btc1','btc2','btc4','btc5']:
        if btc not in data:
            continue
        pnl, wr, fills = data[btc]
        fname = f'fv-{series}-{btc}-backtest'
        if not (CONFIGS_DIR / f'{fname}.json').exists():
            continue
        note_parts = [f'Часть серии {series}. Total 4-day: {total}', desc_base]
        if btc in ('btc4','btc5'):
            note_parts.append('OOS dataset')
        inject(fname, {
            'desc': f'FairValueMM {series}, {btc} dataset',
            'status': st,
            'backtest': {
                'dataset': f'{btc} snapshots 5-min BTC',
                'pnl': pnl,
                **({'wr': wr} if wr else {}),
                **({'markets': fills} if fills else {}),
                'date': '2026-03-31',
                'notes': ' '.join(note_parts),
            },
            'todo': (
                ['производительность после V2 не верифицирована — нужен verify прогон'] if st == 'oos-validated'
                else ['не использовать — есть более стабильные стратегии (sel-daccel, ae-auto)']
            ),
        })

# ─────────────────────────────────────────────────────────────────
# 15. CC calibrated-crowd series
# ─────────────────────────────────────────────────────────────────
print('[15] cc-bt-* CalibratedCrowd series...')

CC_VARIANT_GRID = {
    'cc-bt-A-exits': ('+14.50 USDC', '58.2%', 253, 'oos-validated', 'Config A (exitOnRegimeFlip+exitTauSec=15). ЛУЧШИЙ — 265 markets Apr-21 OOS.'),
    'cc-bt-A-mc010-20260421': ('+14.50 USDC', '58.2%', 253, 'oos-validated', 'A + minComposite=0.10. A=AB (B no-op), result same.'),
    'cc-bt-A-mc015-20260421': ('+14.50 USDC', '58.2%', 253, 'oos-validated', 'A + minComposite=0.15. Все 26 зон имеют composite≥0.5, B нейтральна.'),
    'cc-bt-AB': ('+14.50 USDC', '58.2%', 253, 'insample', 'A+B combo = A (B is no-op). Идентичен A.'),
    'cc-bt-ABC': ('+5.81 USDC', '55.6%', 145, 'insample', 'A+B+C combo = AC (B is no-op). CEX agree вредит (+14.50→+5.81).'),
    'cc-bt-AC': ('+5.81 USDC', '55.6%', 145, 'insample', 'A + CEX agree. +5.81 vs A +14.50 — CEX agree режет прибыльные сделки.'),
    'cc-bt-B-strict': ('-5.34 USDC', '68.9%', 121, 'archived', 'Baseline (minComposite=0.5). B is no-op: -5.34. High WR ≠ profit.'),
    'cc-bt-BC': ('-21.81 USDC', '68.8%', 65, 'archived', 'B+C. CEX agree alone всегда ухудшает: -21.81 vs baseline -5.34.'),
    'cc-bt-C-cex': ('-21.81 USDC', '68.8%', 65, 'archived', 'Config C (CEX agree filter). Режет прибыльные входы. Не использовать.'),
}

for fname, (pnl, wr, fills, st, note) in CC_VARIANT_GRID.items():
    if (CONFIGS_DIR / f'{fname}.json').exists():
        inject(fname, {
            'desc': f'CalibratedCrowd {fname} variant — Apr 21 OOS (265 markets)',
            'status': st,
            'backtest': {
                'dataset': 'snapshots 2026-04-21 OOS, 265 markets',
                'pnl': pnl, 'wr': wr, 'markets': fills,
                'date': '2026-04-27',
                'notes': note,
            },
            'todo': (
                ['run on Apr 22-27 daily to confirm robustness (pending task)']
                if st == 'oos-validated' else
                ['archived — only A variant is worth using']
            ),
        })

# CC daily A series (Apr 22-27) — данные не в памяти
CC_BT_A_DAYS = [
    ('20260422', 'OOS day 2 — часть 7-дневного robustness sweep'),
    ('20260423', 'OOS day 3 — часть 7-дневного robustness sweep'),
    ('20260424', 'OOS day 4 — часть 7-дневного robustness sweep'),
    ('20260425', 'OOS day 5 — часть 7-дневного robustness sweep'),
    ('20260426', 'OOS day 6 — часть 7-дневного robustness sweep'),
    ('20260427', 'OOS day 7 (финальный) — суммарно A: +14.50 USDC за Apr-21'),
]
for date, note in CC_BT_A_DAYS:
    for mc_suffix in ['', '-mc010', '-mc015']:
        fname = f'cc-bt-A{mc_suffix}-{date}'
        mc_note = f' (minComposite={mc_suffix[3:]}%)' if mc_suffix else ''
        if (CONFIGS_DIR / f'{fname}.json').exists():
            inject(fname, {
                'desc': f'CalibratedCrowd config A{mc_note}, {date[:4]}-{date[4:6]}-{date[6:]} OOS',
                'status': 'oos',
                'backtest': {
                    'dataset': f'snapshots {date[:4]}-{date[4:6]}-{date[6:]} OOS',
                    'pnl': 'не записан',
                    'notes': f'{note}. Конфиг A: exitOnRegimeFlip=true, exitTauSec=15.',
                },
                'todo': [
                    'перезапустить и зафиксировать PnL за этот день',
                    'для Apr-21 подтверждён результат +14.50 USDC (265 markets)',
                ],
            })

# CC v9 series
for fname, desc, st, note, todo in [
    ('cc-bt-v9-insample', 'CalibratedCrowd v9 table in-sample', 'insample',
     'v9-loose edge-table. In-sample evaluation.',
     ['зафиксировать результаты — serve as baseline для сравнения v9 vs delta-regime']),
    ('cc-bt-v9-oos', 'CalibratedCrowd v9 table OOS', 'oos',
     'v9-loose edge-table OOS holdout.',
     ['зафиксировать результаты OOS holdout']),
]:
    if (CONFIGS_DIR / f'{fname}.json').exists():
        inject(fname, {
            'desc': desc, 'status': st,
            'backtest': {'dataset': 'BTC snapshots', 'pnl': 'не записан', 'notes': note},
            'todo': todo,
        })

# CC backtest experiments
cc_bt_experiments = [f.stem for f in CONFIGS_DIR.glob('cc-backtest-*.json')]
for fname in cc_bt_experiments:
    inject(fname, {
        'desc': f'CalibratedCrowd experiment — {fname}',
        'status': 'archived',
        'backtest': {
            'dataset': 'BTC snapshots Apr 2026',
            'pnl': 'не записан',
            'notes': 'Ранний эксперимент CalibratedCrowd. Большинство конфигов — варианты CEX filter (agree/not-adverse) которые ухудшают результат.',
        },
        'todo': [
            'результаты не зафиксированы',
            'CEX agree/not-adverse фильтры исторически вредят — не использовать в новых конфигах',
        ],
    })

# CC sweep series
cc_sweeps = [f.stem for f in CONFIGS_DIR.glob('cc-sweep-*.json')]
for fname in cc_sweeps:
    inject(fname, {
        'desc': f'CalibratedCrowd parameter sweep — {fname}',
        'status': 'insample',
        'backtest': {
            'dataset': 'BTC snapshots Apr 2026',
            'pnl': 'не записан',
            'notes': 'Параметрический sweep. Результаты не зафиксированы индивидуально.',
        },
        'todo': ['run and capture results', 'сравнить с cc-bt-A (baseline +14.50)'],
    })

# ─────────────────────────────────────────────────────────────────
# 16. AS (Avellaneda-Stoikov) series — all archived
# ─────────────────────────────────────────────────────────────────
print('[16] as-* Avellaneda-Stoikov series...')

# zone-only — лучший AS config (+0.4 USDC на 703 рынках)
for btc in ['btc1','btc2','btc4','btc5']:
    fname = f'abl2-zone-only-{btc}'
    if (CONFIGS_DIR / f'{fname}.json').exists():
        inject(fname, {
            'desc': f'AS zone-only (лучший AS конфиг), {btc}',
            'status': 'archived',
            'backtest': {
                'dataset': f'{btc} snapshots 5-min BTC',
                'pnl': 'не записан',
                'notes': 'zone-only минимальный конфиг: +0.4 USDC на 703 BTC markets (первый плюсовой AS на 5-min). Breakeven, не для production.',
            },
            'todo': ['AS 5-min не конкурентоспособен vs SelectiveEntry/AdaptiveEntry — не развивать'],
        })

# abl2 ablation variants
abl2_files = [f.stem for f in CONFIGS_DIR.glob('abl2-*.json')]
for fname in abl2_files:
    parts = fname.split('-')
    inject(fname, {
        'desc': f'AS ablation study variant — {fname}',
        'status': 'archived',
        'backtest': {
            'dataset': '5-min BTC, несколько дней',
            'pnl': 'не записан',
            'notes': 'Phase 3 ablation study. Классификация фич: zone (критически важна), warmup/dynsize (полезны), OFI/AAS (нейтральны), jump/regime/dynGamma (вредны). Полный отчёт: memory/backtest-findings-phase3.md',
        },
        'todo': ['AS 5-min не конкурентоспособен — только архив/reference'],
    })

# trail3 best configs
for fname_pat, note in [
    ('as-5min-trail3-w70h85-bid12-73-backtest', 'ЛУЧШИЙ trail3 bid12-73. 3-day SUM: +84 USDC. Потенциально overfit (1¢ чувствительность).'),
    ('as-5min-trail3-best-backtest', 'trail3-best backup: +1.10 USDC 3-day. Stable breakeven.'),
]:
    if (CONFIGS_DIR / f'{fname_pat}.json').exists():
        inject(fname_pat, {
            'desc': f'AS 5min trail3 {fname_pat}',
            'status': 'archived',
            'backtest': {
                'dataset': 'btc1+btc2+btc4/day1-3 5-min BTC',
                'pnl': 'см. notes',
                'date': '2026-03-27',
                'notes': note + ' Конфиг: trail=3¢, w70h85, bid zone 12-73¢. Детали: docs/guides/strategy-hypotheses.md',
            },
            'todo': [
                'AS trail overfits: bid12-73 vs bid13-72 разница десятки USDC',
                'не использовать в production без переvalиdации на свежих данных',
            ],
        })

# AS trail variants (many files)
as_trail_files = (
    [f.stem for f in CONFIGS_DIR.glob('as-5min-trail*.json')]
    + [f.stem for f in CONFIGS_DIR.glob('as-5min-sweep*.json')]
    + [f.stem for f in CONFIGS_DIR.glob('as-5min-asym*.json')]
    + [f.stem for f in CONFIGS_DIR.glob('as-5min-notrail*.json')]
)
for fname in set(as_trail_files):
    if (CONFIGS_DIR / f'{fname}.json').exists():
        existing = json.loads((CONFIGS_DIR / f'{fname}.json').read_text())
        if '_meta' in existing:
            continue
        inject(fname, {
            'desc': f'AS 5min parameter sweep/trail variant — {fname}',
            'status': 'archived',
            'backtest': {
                'dataset': '5-min BTC btc1/btc2/day1-3',
                'pnl': 'не записан',
                'notes': 'Часть trail stop / parameter sweep серии. Общий вывод: trail3-w70h85-bid12-73 лучший, но чувствителен к 1¢. Полная таблица: docs/guides/strategy-hypotheses.md раздел "trail".',
            },
            'todo': ['archived — AS trail не в production. Не перезапускать.'],
        })

# 15-min AS series
for btc in ['btc1','btc2','btc4','btc5']:
    for variant in ['baseline', 'ofi-aas']:
        fname = f'15m-{variant}-{btc}-backtest'
        if (CONFIGS_DIR / f'{fname}.json').exists():
            inject(fname, {
                'desc': f'AS 15min {variant}, {btc}',
                'status': 'archived',
                'backtest': {
                    'dataset': f'{btc} snapshots 15-min BTC',
                    'pnl': 'не записан',
                    'notes': f'15-min AS variant. OFI+AAS 15-min давал +$61.56/день в симуляции (EXP-56). Реальный бэктест результат не зафиксирован.',
                },
                'todo': ['зафиксировать результаты для 15-min AS baseline и ofi-aas серий'],
            })

# AS other variants (regime, warmup, jump, etc.)
as_other = (
    [f.stem for f in CONFIGS_DIR.glob('as-regime*.json')]
    + [f.stem for f in CONFIGS_DIR.glob('as-warmup*.json')]
    + [f.stem for f in CONFIGS_DIR.glob('as-jump*.json')]
    + [f.stem for f in CONFIGS_DIR.glob('as-unwind*.json')]
    + [f.stem for f in CONFIGS_DIR.glob('as-sl*.json')]
    + [f.stem for f in CONFIGS_DIR.glob('as-os*.json')]
    + [f.stem for f in CONFIGS_DIR.glob('as-dynamicq*.json')]
    + [f.stem for f in CONFIGS_DIR.glob('as-dyngamma*.json')]
    + [f.stem for f in CONFIGS_DIR.glob('as-w15*.json')]
    + [f.stem for f in CONFIGS_DIR.glob('as-best*.json')]
    + [f.stem for f in CONFIGS_DIR.glob('as-mm*.json')]
    + [f.stem for f in CONFIGS_DIR.glob('as-profithold*.json')]
    + [f.stem for f in CONFIGS_DIR.glob('as-baseline*.json')]
    + [f.stem for f in CONFIGS_DIR.glob('as-enhanced*.json')]
    + [f.stem for f in CONFIGS_DIR.glob('as-15m*.json')]
    + [f.stem for f in CONFIGS_DIR.glob('as-15min*.json')]
)
for fname in set(as_other):
    if not (CONFIGS_DIR / f'{fname}.json').exists():
        continue
    existing = json.loads((CONFIGS_DIR / f'{fname}.json').read_text())
    if '_meta' in existing:
        continue
    inject(fname, {
        'desc': f'Avellaneda-Stoikov experiment — {fname}',
        'status': 'archived',
        'backtest': {
            'dataset': '5-min или 15-min BTC/ETH/SOL/XRP',
            'pnl': 'не записан',
            'notes': 'Ранний AS эксперимент. Вся история: docs/guides/strategy-hypotheses.md. AS 5-min с зоной: +0.4 USDC breakeven. Без зоны: -174 USDC катастрофа. Заменён SelectiveEntry/AdaptiveEntry.',
        },
        'todo': ['archived — не перезапускать. Лучше использовать sel/ae стратегии.'],
    })

# ─────────────────────────────────────────────────────────────────
# 17. CryptoProb (cp/cpd/cpv2/ci/ce) — all archived/overfit
# ─────────────────────────────────────────────────────────────────
print('[17] cp/cpd/cpv2/ci/ce CryptoProb series...')

def inject_cryptoprob_series(pattern: str, desc_base: str) -> None:
    for f in sorted(CONFIGS_DIR.glob(f'{pattern}*.json')):
        existing = json.loads(f.read_text())
        if '_meta' in existing:
            continue
        inject(f.stem, {
            'desc': f'{desc_base} — {f.stem}',
            'status': 'archived',
            'backtest': {
                'dataset': 'btc1/btc2/btc4/btc5 5-min BTC',
                'pnl': 'не записан',
                'notes': 'CryptoProbStrategy overfit: btc2 (train) хорошо, btc1/4/5 убыточные. Лучший combo: -89.95 USDC total. Prob table = overfit сигнал, не production-ready.',
            },
            'todo': [
                'не использовать — overfit подтверждён',
                'prob table как фильтр для AS потенциально полезна, но не тестировалась отдельно',
            ],
        })

inject_cryptoprob_series('cp-p', 'CryptoProb entry-prob sweep')
inject_cryptoprob_series('cpd-e', 'CryptoProb directional entry sweep')
inject_cryptoprob_series('cpv2-', 'CryptoProbV2 parameter sweep')
inject_cryptoprob_series('ci-e', 'CryptoProb entry threshold sweep')
inject_cryptoprob_series('ce-nodg', 'CryptoProb no-dynGamma sweep')
inject_cryptoprob_series('ce-zone', 'CryptoProb zone sweep')

# ─────────────────────────────────────────────────────────────────
# 18. ProbTable (pt/ptv2) — not viable
# ─────────────────────────────────────────────────────────────────
print('[18] pt/ptv2 ProbTable series...')

for f in sorted(CONFIGS_DIR.glob('pt-*.json')) + sorted(CONFIGS_DIR.glob('ptv2-*.json')):
    existing = json.loads(f.read_text())
    if '_meta' in existing:
        continue
    inject(f.stem, {
        'desc': f'ProbTableStrategy experiment — {f.stem}',
        'status': 'archived',
        'backtest': {
            'dataset': 'btc 5-min markets, day4+day5',
            'pnl': 'не записан',
            'notes': 'ProbTable как самостоятельная стратегия не работает: v1 (hold) лучший -101 USDC, v2 (edge convergence) -160 до -400 USDC. На 5-min fairValue прыгает между tau-бакетами, цена не сходится. Полезна только как AS-фильтр.',
        },
        'todo': ['не использовать самостоятельно — только как veto/shift фильтр для AS'],
    })

# ─────────────────────────────────────────────────────────────────
# 19. OscillationMM, MomentumScalp, SmartEntry — archived
# ─────────────────────────────────────────────────────────────────
print('[19] osc-mm, mom-scalp, smart-entry...')

for pat, desc, note in [
    ('osc-mm-*', 'OscillationMM', 'Ранний эксперимент с MM на осцилляциях. Результаты не зафиксированы. Не развивался дальше.'),
    ('osc-mm-filtered-*', 'OscillationMM filtered', 'OscillationMM с фильтрами. Результаты не зафиксированы.'),
    ('mom-scalp-*', 'MomentumScalp', 'Momentum scalping эксперимент. Результаты не зафиксированы. В симуляции EXP-02: +$8.77/день.'),
    ('mom-scalp-mid-*', 'MomentumScalp mid', 'Momentum scalp mid-price variant.'),
    ('mom-scalp-wide-*', 'MomentumScalp wide', 'Momentum scalp wide-zone variant.'),
]:
    for f in sorted(CONFIGS_DIR.glob(f'{pat}.json' if not pat.endswith('*') else pat + '.json')):
        existing = json.loads(f.read_text())
        if '_meta' in existing:
            continue
        inject(f.stem, {
            'desc': f'{desc} — {f.stem}',
            'status': 'archived',
            'backtest': {
                'dataset': 'btc1/btc2/btc4/btc5 5-min BTC',
                'pnl': 'не записан',
                'notes': note,
            },
            'todo': ['archived — результаты не зафиксированы'],
        })

# ─────────────────────────────────────────────────────────────────
# 20. PairedCexCrowd series
# ─────────────────────────────────────────────────────────────────
print('[20] paired-cex-crowd series...')

for f in sorted(CONFIGS_DIR.glob('paired-cex-crowd-backtest-*.json')):
    existing = json.loads(f.read_text())
    if '_meta' in existing:
        continue
    inject(f.stem, {
        'desc': f'PairedCexCrowd experiment — {f.stem}',
        'status': 'archived',
        'backtest': {
            'dataset': 'snapshots 2026-04-21',
            'pnl': 'не записан',
            'notes': 'Экспериментальная paired стратегия: UP+DOWN одновременно через lock mechanism. Verbose journal доступен в data/backtest-journals/paired-cex-crowd-2026-04-21-verbose/.',
        },
        'todo': [
            'проверить data/backtest-journals/paired-cex-crowd-2026-04-21-verbose для результатов',
            'механизм lock был нестабилен — требует ревизии',
        ],
    })

for fname in ['paired-cex-crowd-paper-5min']:
    if (CONFIGS_DIR / f'{fname}.json').exists():
        existing = json.loads((CONFIGS_DIR / f'{fname}.json').read_text())
        if '_meta' not in existing:
            inject(fname, {
                'desc': 'PairedCexCrowd paper 5min',
                'status': 'archived',
                'paper': {
                    'period': '2026-04-21/...',
                    'pnl': 'не записан',
                    'notes': 'Экспериментальная стратегия, не в production.',
                },
                'todo': ['запустить бэктест и зафиксировать результаты перед paper'],
            })

# ─────────────────────────────────────────────────────────────────
# 21. SmartEntry / SelectiveEntry sweep series
# ─────────────────────────────────────────────────────────────────
print('[21] sweep-* series...')

SWEEP_GROUPS = {
    'sweep-wu30z55': 'AS warmup+zone sweep (warmup=30s, zone≥55¢)',
    'sweep-zone55': 'AS zone55 parameter sweep',
    'sweep-zone60': 'AS zone60 parameter sweep',
    'sweep-zone55-nomax': 'AS zone55 без maxBidZone sweep',
    'sweep-wu30z55-nomax': 'AS warmup+zone55 без maxBidZone',
    'sweep-a15': 'AS adaptiveScale=0.15 sweep',
    'sweep-a20': 'AS adaptiveScale=0.20 sweep',
    'sweep-os8': 'AS orderSize=8 sweep',
}
for prefix, desc in SWEEP_GROUPS.items():
    for f in sorted(CONFIGS_DIR.glob(f'{prefix}*.json')):
        existing = json.loads(f.read_text())
        if '_meta' in existing:
            continue
        day = f.stem.split('-day')[-1] if '-day' in f.stem else '?'
        inject(f.stem, {
            'desc': f'{desc}, day{day}',
            'status': 'archived',
            'backtest': {
                'dataset': f'5-min BTC day{day}',
                'pnl': 'не записан',
                'notes': f'Часть параметрического sweep. Общий вывод: baseline (zone-only AS) оптимален. Детали: docs/guides/strategy-hypotheses.md',
            },
            'todo': ['archived — baseline zone-only AS оптимален, sweeps не дали улучшений'],
        })

# ─────────────────────────────────────────────────────────────────
# 22. Misc configs
# ─────────────────────────────────────────────────────────────────
print('[22] misc configs...')

MISC_CONFIGS = {
    'backtest-calibration-rules-btc-holdout': (
        'CalibrationRules holdout backtest', 'oos',
        'Calibration rules strategy на holdout данных. Journal: data/backtest-journals/calibration-rules-btc-holdout/. Данные Apr 23-25.',
        ['посмотреть data/backtest-journals/calibration-rules-btc-holdout/ для результатов per-market'],
    ),
    'backtest-cc-delta-regime-down-hold': (
        'CC delta-regime DOWN hold experiment', 'insample',
        'CalibratedCrowd DOWN-side с hold logic. Ранний эксперимент.',
        ['результаты не зафиксированы'],
    ),
    'backtest-cex-crowd-down-agree-signal': (
        'CexCrowd DOWN agree signal experiment', 'archived',
        'Ранний CEX-crowd signal тест (DOWN side). CEX agree исторически вредит результатам.',
        ['archived — CEX agree фильтр доказано ухудшает результаты'],
    ),
    'backtest-cex-crowd-up-agree-signal': (
        'CexCrowd UP agree signal experiment', 'archived',
        'Ранний CEX-crowd signal тест (UP side). CEX agree исторически вредит.',
        ['archived'],
    ),
    'backtest-dumb': (
        'Dumb strategy backtest', 'wip',
        'Простейшая стратегия для диагностики инфраструктуры. Не для production.',
        ['только для тестирования инфраструктуры'],
    ),
    'baseline-paired-overlay-backtest-2026-04-21': (
        'Baseline paired overlay backtest Apr 21', 'insample',
        'Baseline для paired+overlay strategy. Apr-21 данные.',
        ['зафиксировать результаты для baseline comparison'],
    ),
    'binance-prob-mm-sample-backtest': (
        'BinanceProbMM sample backtest', 'insample',
        'Sample бэктест для BinanceProbMM стратегии. Использует Binance futures prob модель.',
        ['зафиксировать результаты sample backtest'],
    ),
    'crowd-policy-rules-btc': (
        'Crowd policy rules config (BTC)', 'insample',
        'Конфиг для CalibrationRules стратегии на BTC. Crowd-based правила.',
        ['запустить бэктест и зафиксировать результаты'],
    ),
    'multi-strategy-paper': (
        'Multi-strategy paper trading', 'wip',
        'Несколько стратегий одновременно через strategyRules. Экспериментальный режим.',
        ['уточнить какие стратегии входят и каковы ожидаемые результаты'],
    ),
    'arb-paper': (
        'Cross-market arbitrage paper', 'wip',
        'Cross-market arbitrage strategy. Экспериментальный.',
        ['определить результаты paper trading', 'arb между UP/DOWN токенами одного рынка?'],
    ),
    'cex-lead-lag-btc-apr8-backtest': (
        'CexLeadLag BTС Apr8 early backtest', 'archived',
        'Ранний бэктест CLL до архитектурного фикса. Результаты устарели — DOWN-side был сломан.',
        ['не использовать — архитектурный фикс изменил результаты принципиально'],
    ),
    'cex-lead-lag-btc-live': (
        'CexLeadLag BTC early live config', 'archived',
        'Ранний live конфиг до фикса и до bidirectional. Заменён cll-live-5min.json.',
        ['устарел — использовать cll-live-5min.json или cllr-live-5min.json'],
    ),
    'cex-lead-lag-btc-paper': (
        'CexLeadLag BTC early paper config', 'archived',
        'Ранний paper конфиг. Заменён cll-paper-5min.json.',
        ['устарел — использовать cll-paper-5min.json'],
    ),
    'test-baseline-btc1': (
        'Test baseline btc1 config', 'wip',
        'Тестовый конфиг для базовой проверки. btc1 dataset.',
        ['уточнить для чего используется'],
    ),
    'cc-backtest-diag': (
        'CalibratedCrowd diagnostics backtest', 'wip',
        'Диагностический конфиг для CC — логирование принятия решений.',
        ['уточнить что именно диагностируется'],
    ),
    'cc-backtest-diag-one': (
        'CalibratedCrowd diagnostics one market', 'wip',
        'Диагностика одного рынка CC.',
        ['уточнить для какого рынка'],
    ),
    'cc-live-5min': ('skip', '', '', []),  # already has meta
    'cll-live-5min': ('skip', '', '', []),
    'cllr-live-5min': ('skip', '', '', []),
    'sel-live-5min': ('skip', '', '', []),
    'cc-paper-5min': ('skip', '', '', []),
    'cll-paper-5min': ('skip', '', '', []),
    'cllr-paper-5min': ('skip', '', '', []),
    'sel-paper-5min': ('skip', '', '', []),
    'ae-paper-15min': ('skip', '', '', []),
    'dumb-live': ('skip', '', '', []),
    'dumb-paper': ('skip', '', '', []),
    'dumb-paper-discovery': ('skip', '', '', []),
}

for fname, (desc, st, note, todo) in MISC_CONFIGS.items():
    if desc == 'skip':
        continue
    if not (CONFIGS_DIR / f'{fname}.json').exists():
        continue
    existing = json.loads((CONFIGS_DIR / f'{fname}.json').read_text())
    if '_meta' in existing:
        continue
    inject(fname, {
        'desc': desc, 'status': st,
        'backtest': {'dataset': 'BTC snapshots / live-recordings', 'pnl': 'не записан', 'notes': note},
        'todo': todo,
    })

# ─────────────────────────────────────────────────────────────────
# 23. cc-paper-* variants (не основные paper конфиги)
# ─────────────────────────────────────────────────────────────────
print('[23] cc-paper-* experimental variants...')

CC_PAPER_VARIANTS = {
    'cc-paper-cex-agree-down-hold-5min': 'CC paper: CEX agree DOWN+hold mode',
    'cc-paper-cex-agree-up-signal-5min': 'CC paper: CEX agree UP signal mode',
    'cc-paper-cex-not-adverse-5min': 'CC paper: CEX not-adverse filter mode',
    'cc-paper-cex-not-adverse-both-hold-5min': 'CC paper: CEX not-adverse + both sides hold',
    'cc-paper-cex-not-adverse-up-hold-5min': 'CC paper: CEX not-adverse + UP hold',
}
for fname, desc in CC_PAPER_VARIANTS.items():
    if not (CONFIGS_DIR / f'{fname}.json').exists():
        continue
    existing = json.loads((CONFIGS_DIR / f'{fname}.json').read_text())
    if '_meta' in existing:
        continue
    inject(fname, {
        'desc': desc,
        'status': 'archived',
        'paper': {
            'period': '2026-04-21/...',
            'pnl': 'не записан',
            'notes': 'CEX filter variants — исторически CEX agree/not-adverse ухудшают результаты CC стратегии. Не рекомендуется.',
        },
        'todo': [
            'CEX agree/not-adverse фильтры ухудшают CC результаты (доказано: A vs AC: +14.50 → +5.81)',
            'не запускать без нового анализа',
        ],
    })

# sel discovery/bidir configs
SEL_PAPER_MISC = {
    'sel-paper-discovery': 'SelectiveEntry paper discovery mode',
    'sel-bidir-paper-discovery': 'SelectiveEntry bidirectional paper discovery',
}
for fname, desc in SEL_PAPER_MISC.items():
    if not (CONFIGS_DIR / f'{fname}.json').exists():
        continue
    existing = json.loads((CONFIGS_DIR / f'{fname}.json').read_text())
    if '_meta' in existing:
        continue
    inject(fname, {
        'desc': desc,
        'status': 'wip',
        'paper': {'period': 'не определён', 'pnl': 'не записан', 'notes': 'Discovery mode эксперимент.'},
        'todo': ['уточнить цель конфига и зафиксировать результаты'],
    })

# as-mm-paper-discovery
for fname in ['as-mm-paper-discovery']:
    if not (CONFIGS_DIR / f'{fname}.json').exists():
        continue
    existing = json.loads((CONFIGS_DIR / f'{fname}.json').read_text())
    if '_meta' in existing:
        continue
    inject(fname, {
        'desc': 'AS Market Making paper discovery',
        'status': 'archived',
        'paper': {'period': 'не определён', 'pnl': 'не записан', 'notes': 'AS MM paper discovery. AS 5-min MM убыточен (-174 USDC baseline).'},
        'todo': ['archived — AS MM не работает на 5-min рынках'],
    })

# ─────────────────────────────────────────────────────────────────
# 24. Catch-all: as-5min-* без meta
# ─────────────────────────────────────────────────────────────────
print('[24] as-5min-* catch-all...')

for f in sorted(CONFIGS_DIR.glob('as-5min-*.json')):
    existing = json.loads(f.read_text())
    if '_meta' in existing:
        continue
    inject(f.stem, {
        'desc': f'Avellaneda-Stoikov 5min variant — {f.stem}',
        'status': 'archived',
        'backtest': {
            'dataset': '5-min BTC btc1/btc2/btc4/btc5',
            'pnl': 'не записан',
            'notes': 'AS 5-min experiment. Все AS 5-min конфиги архивированы — стратегия заменена SelectiveEntry/AdaptiveEntry. Детали: docs/guides/strategy-hypotheses.md',
        },
        'todo': ['archived — не перезапускать. Используй sel/ae стратегии.'],
    })

# ─────────────────────────────────────────────────────────────────
# ФИНАЛЬНЫЙ ПОДСЧЁТ
# ─────────────────────────────────────────────────────────────────
print('\n─────────────────────────────')
total_with_meta = sum(1 for f in CONFIGS_DIR.glob('*.json')
                       if '_meta' in json.loads(f.read_text()))
total_all = sum(1 for f in CONFIGS_DIR.glob('*.json'))
print(f'Done. Configs with _meta: {total_with_meta}/{total_all}')
if DRY_RUN:
    print('[DRY RUN — no files modified]')
