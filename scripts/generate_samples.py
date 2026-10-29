"""Gera as oscilografias de exemplo do Oscilo – 100% sintéticas.

    python scripts/generate_samples.py [--out samples]

Nenhum dado vem de registros reais: os sinais são calculados a partir de
modelos simples de rede (componentes simétricas, componente DC de falta,
inrush, abertura de disjuntor no zero de corrente, oscilação entre duas
máquinas). A ESTRUTURA dos arquivos (nº e tipo de canais, relações de TC/TP,
taxas, formatos e revisões COMTRADE) imita registros típicos de relés de
transformador e de registradores de perturbação, para exercitar o software
em condições realistas.

Exemplos gerados:
  demo_falta_transformador  2 kHz BINARY 2013  42A/128D  falta interna AT (87T atua)
  demo_87t_exportacao       2 kHz ASCII  2013  25A/115D  falta externa BT (87T estável)
  demo_87t_diferencial     16 kHz BINARY 1997  41A/45D   energização (inrush) + falta interna
  demo_oscilacao_potencia   2 kHz FLOAT32 2013  8A/16D    oscilação estável + perda de sincronismo
"""

from __future__ import annotations

import argparse
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

F0 = 60.0
W = 2 * np.pi * F0
A = np.exp(2j * np.pi / 3)
STATION = "SUBESTACAO_DEMO"
DATE = "15/01/2020"
RNG = np.random.default_rng(20200115)


# ---------------------------------------------------------------------------
# Escrita COMTRADE
# ---------------------------------------------------------------------------
@dataclass
class Analog:
    name: str
    ph: str
    unit: str
    primary: float
    secondary: float
    values: np.ndarray  # valores PRIMÁRIOS instantâneos

    @property
    def ratio(self) -> float:
        return self.primary / self.secondary


@dataclass
class Digital:
    name: str
    values: np.ndarray  # 0/1
    normal: int = 0


@dataclass
class Record:
    device: str
    fs: float
    t: np.ndarray
    trigger_s: float
    analogs: list[Analog] = field(default_factory=list)
    digitals: list[Digital] = field(default_factory=list)

    def write(self, folder: Path, fmt: str = "BINARY", rev: str = "2013") -> None:
        folder.mkdir(parents=True, exist_ok=True)
        n = len(self.t)
        na, nd = len(self.analogs), len(self.digitals)
        lines = [f"{STATION},{self.device},{rev}", f"{na + nd},{na}A,{nd}D"]
        raw_cols = []
        for i, ch in enumerate(self.analogs, 1):
            sec = ch.values / ch.ratio  # gravado em valores secundários (PS = S)
            sec = sec + RNG.normal(0, 1e-4 * (np.max(np.abs(sec)) + 1e-9), n)  # ruído de quantização/medição
            if fmt == "FLOAT32":
                a, b, cmin, cmax = 1.0, 0.0, "-3.40282e+38", "3.40282e+38"
                raw = sec.astype(np.float32)
            else:
                peak = max(float(np.max(np.abs(sec))), 1e-6)
                a, b, cmin, cmax = peak / 32000.0, 0.0, "-32767", "32767"
                raw = np.round(sec / a).astype(np.int64)
            raw_cols.append(raw)
            lines.append(f"{i},{ch.name},{ch.ph},,{ch.unit},{a:.17e},{b:.17e},0.000000e+00,{cmin},{cmax},"
                         f"{ch.primary:.6e},{ch.secondary:.6e},S")
        for j, ch in enumerate(self.digitals, 1):
            lines.append(f"{j},{ch.name},,,{ch.normal}")
        start = "10:00:00.000000"
        trig = f"10:00:{self.trigger_s:09.6f}"
        lines += [f"{F0:.1f}", "1", f"{self.fs:.6f},{n}", f"{DATE},{start}", f"{DATE},{trig}", fmt, "1.000000"]
        if rev == "2013":
            lines += ["-3,-3", "0,0"]
        (folder / "registro.cfg").write_text("\r\n".join(lines) + "\r\n", encoding="ascii")

        ts = np.round(self.t * 1e6).astype(np.int64)
        dig = np.column_stack([d.values.astype(np.uint8) for d in self.digitals]) if nd else np.zeros((n, 0), np.uint8)
        if fmt == "ASCII":
            cols = [np.arange(1, n + 1), ts, *raw_cols, *[dig[:, k] for k in range(nd)]]
            data = np.column_stack(cols)
            with open(folder / "registro.dat", "w", newline="\r\n") as fh:
                np.savetxt(fh, data, fmt="%d", delimiter=",")
            return
        a_type = {"BINARY": "<i2", "BINARY32": "<i4", "FLOAT32": "<f4"}[fmt]
        nwords = (nd + 15) // 16
        dt = np.dtype([("n", "<u4"), ("ts", "<u4"), ("a", a_type, (na,)), ("d", "<u2", (nwords,))])
        rec = np.zeros(n, dt)
        rec["n"] = np.arange(1, n + 1)
        rec["ts"] = ts
        rec["a"] = np.column_stack(raw_cols)
        for k in range(nd):
            rec["d"][:, k // 16] |= (dig[:, k].astype(np.uint16) << (k % 16))
        (folder / "registro.dat").write_bytes(rec.tobytes())

    def write_hdr(self, folder: Path, title: str, text: str) -> None:
        body = [
            f"Station Name: {STATION}",
            f"Device: {self.device}",
            "Record type: SINTETICO (gerado por scripts/generate_samples.py)",
            f"Start time: {DATE} 10:00:00.000000",
            f"Trigger time: {DATE} 10:00:{self.trigger_s:09.6f}",
            f"Event: {title}",
            "",
            text,
        ]
        (folder / "registro.hdr").write_text("\r\n".join(body) + "\r\n", encoding="ascii")


# ---------------------------------------------------------------------------
# Ferramentas de sinais
# ---------------------------------------------------------------------------
def inst(phasor: np.ndarray, t: np.ndarray) -> np.ndarray:
    """Fasor RMS (por amostra) → valor instantâneo."""
    return np.real(np.sqrt(2) * phasor * np.exp(1j * W * t))


def step(t: np.ndarray, t0: float, before, after):
    return np.where(t >= t0, after, before)


def dc_offset(i_inst: np.ndarray, t: np.ndarray, t0: float, tau: float, pre: np.ndarray | None = None) -> np.ndarray:
    """Adiciona componente DC no instante t0 para manter a continuidade da corrente."""
    k = int(np.searchsorted(t, t0))
    if k <= 0 or k >= len(t):
        return i_inst
    before = (pre if pre is not None else i_inst)[k - 1]
    jump = before - i_inst[k]
    out = i_inst.copy()
    out[k:] += jump * np.exp(-(t[k:] - t[k]) / tau)
    return out


def open_at_zero(x: np.ndarray, t: np.ndarray, t_cmd: float, ringdown: float = 0.0) -> np.ndarray:
    """Interrompe o sinal no primeiro cruzamento por zero após t_cmd."""
    k = int(np.searchsorted(t, t_cmd))
    s = np.sign(x[k:])
    zc = np.flatnonzero(s[1:] * s[:-1] <= 0)
    cut = k + (int(zc[0]) + 1 if len(zc) else 0)
    out = x.copy()
    if ringdown > 0:
        out[cut:] = x[cut:] * np.exp(-(t[cut:] - t[cut]) / ringdown) * 0.05
    else:
        out[cut:] = 0.0
    return out


def seq_to_abc(x0, x1, x2):
    return x0 + x1 + x2, x0 + A**2 * x1 + A * x2, x0 + A * x1 + A**2 * x2


def smooth(x: np.ndarray, fs: float, cycles: float = 1.0) -> np.ndarray:
    n = max(int(fs / F0 * cycles), 1)
    k = np.ones(n) / n
    return np.convolve(x, k, mode="same")


def ramp(t, t0, t1, v0, v1):
    return np.interp(t, [t0, t1], [v0, v1])


def mask(t, intervals):
    m = np.zeros(len(t), np.uint8)
    for a, b in intervals:
        m[(t >= a) & (t < b)] = 1
    return m


# ---------------------------------------------------------------------------
# 1) Relé de transformador 500/34,5 kV – falta interna fase A-terra no lado AT
# ---------------------------------------------------------------------------
def transformer_relay_event(fs: float, n: int, kind: str, layout: str):
    """kind: 'interna' (falta AT, 87T atua) | 'externa' (falta BC na BT, 87T estável).
    layout: 'rel42' (42A/128D) | 'exp25' (25A/115D)."""
    t = np.arange(n) / fs
    tf = 3.0 + 0.25 / F0  # instante da falta (¼ de ciclo após 3 s → componente DC visível)
    vn_hv, vn_lv = 500e3 / np.sqrt(3), 34.5e3 / np.sqrt(3)
    s_nom = 150e6
    in_hv, in_lv = s_nom / (np.sqrt(3) * 500e3), s_nom / (np.sqrt(3) * 34.5e3)

    # carga pré-falta: 0,8 pu, fp 0,92 indutivo; YNd1 → BT atrasada 30°
    i_load = 0.8 * in_hv * np.exp(-1j * np.arccos(0.92))
    abc = np.array([1, A**2, A])
    hv_load = i_load * abc
    lv_load = -0.8 * in_lv * np.exp(-1j * np.arccos(0.92)) * np.exp(-1j * np.pi / 6) * abc  # TC apontando p/ o trafo

    v_hv = vn_hv * np.array([1, A**2, A], dtype=complex)[:, None] * np.ones(n)
    v_lv = 0.98 * vn_lv * np.exp(-1j * np.pi / 6) * np.array([1, A**2, A])[:, None] * np.ones(n)
    v_lv2 = 0.99 * vn_lv * np.exp(-1j * np.pi / 6) * np.array([1, A**2, A])[:, None] * np.ones(n)
    i_hv = hv_load[:, None] * np.ones(n)
    i_lv = lv_load[:, None] * np.ones(n)
    in_neutral = np.zeros(n, complex)
    lv_neutral = np.zeros(n, complex)
    fault = t >= tf

    if kind == "interna":
        # falta A-terra franca nos terminais AT, alimentada pelo sistema 500 kV
        z1, z0 = 2.0 + 28j, 3.0 + 36j
        i0 = vn_hv / (2 * z1 + z0)
        v0, v1, v2 = -z0 * i0, vn_hv - z1 * i0, -z1 * i0
        va, vb, vc = seq_to_abc(v0, v1, v2)
        for p, v in enumerate((va, vb, vc)):
            v_hv[p, fault] = v
        i_hv[0, fault] = hv_load[0] + 3 * i0
        in_neutral[fault] = 0.55 * 3 * i0  # parcela de seq. zero pelo neutro do trafo
        for p in range(3):  # BT: tensão afunda (acoplamento de seq. +/−), carga cai
            v_lv[p, fault] = v_lv[p, fault] * (0.62 if p != 1 else 0.95)
            i_lv[p, fault] = lv_load[p] * 0.7
        t_trip, t_open = tf + 0.020, tf + 0.062
    else:
        # falta B-C no alimentador de 34,5 kV, fora da zona; eliminada pela proteção do alimentador
        if_lv = 9.5e3  # A na BT
        t_clear = tf + 0.150
        dur = (t >= tf) & (t < t_clear)
        ib_lv = -1j * if_lv * np.exp(-1j * np.radians(80))
        lv_f = np.array([0, ib_lv, -ib_lv])
        # corrente passante refletida no AT (Dy1: atraso de 30°, relação 34,5/500)
        lv_seq1 = (lv_f[0] + A * lv_f[1] + A**2 * lv_f[2]) / 3
        lv_seq2 = (lv_f[0] + A**2 * lv_f[1] + A * lv_f[2]) / 3
        hv_seq1 = lv_seq1 * (34.5 / 500) * np.exp(1j * np.pi / 6)
        hv_seq2 = lv_seq2 * (34.5 / 500) * np.exp(-1j * np.pi / 6)
        hv_f = np.array(seq_to_abc(0, hv_seq1, hv_seq2))
        for p in range(3):
            i_lv[p, dur] = lv_load[p] * 0.4 - lv_f[p]
            i_hv[p, dur] = hv_load[p] * 0.4 + hv_f[p]
            v_lv[p, dur] = v_lv[p, dur] * (1.0 if p == 0 else 0.45)
            v_lv2[p, dur] = v_lv2[p, dur] * (1.0 if p == 0 else 0.55)
            v_hv[p, dur] = v_hv[p, dur] * (0.99 if p == 0 else 0.93)
        t_trip, t_open = None, None

    # instantâneos (com DC nas correntes de falta, X/R ≈ 14 → τ ≈ 37 ms)
    hv_i = [dc_offset(inst(i_hv[p], t), t, tf, 0.037, pre=inst(hv_load[p] * np.ones(n), t)) for p in range(3)]
    lv_i = [dc_offset(inst(i_lv[p], t), t, tf, 0.037, pre=inst(lv_load[p] * np.ones(n), t)) for p in range(3)]
    if kind == "externa":  # abertura do alimentador: continuidade da corrente (sem degrau)
        hv_i = [dc_offset(x, t, t_clear, 0.012) for x in hv_i]
        lv_i = [dc_offset(x, t, t_clear, 0.012) for x in lv_i]
    hv_v = [inst(v_hv[p], t) for p in range(3)]
    lv_v = [inst(v_lv[p], t) for p in range(3)]
    lv_v2 = [inst(v_lv2[p], t) for p in range(3)]
    neu = dc_offset(inst(in_neutral, t), t, tf, 0.037, pre=np.zeros(n))
    if t_open:
        hv_i = [open_at_zero(x, t, t_open) for x in hv_i]
        lv_i = [open_at_zero(x, t, t_open - 0.002) for x in lv_i]
        hv_v = [open_at_zero(x, t, t_open + 0.004, ringdown=0.02) for x in hv_v]
        lv_v = [open_at_zero(x, t, t_open, ringdown=0.02) for x in lv_v]
        neu = open_at_zero(neu, t, t_open)

    # disjuntor-e-meio: dois disjuntores AT dividem a corrente + fluxo passante do vão
    through = 380.0 * np.exp(-1j * np.radians(12)) * abc
    b1 = [hv_i[p] / 2 + inst(through[p] * np.ones(n), t) for p in range(3)]
    b2 = [hv_i[p] / 2 - inst(through[p] * np.ones(n), t) for p in range(3)]
    res_b = sum(b1) + sum(b2)

    # grandezas calculadas pelo relé (pu da nominal), suavizadas em 1 ciclo
    def mag(ph):
        return np.abs(ph)

    i_hv_pu = [i_hv[p] / in_hv for p in range(3)]
    i_lv_pu = [i_lv[p] / in_lv * np.exp(1j * np.pi / 6) for p in range(3)]
    if t_open:
        cut = t >= t_open + 0.008
        for p in range(3):
            i_hv_pu[p] = np.where(cut, 0, i_hv_pu[p])
            i_lv_pu[p] = np.where(cut, 0, i_lv_pu[p])
    idiff = [smooth(mag(i_hv_pu[p] + i_lv_pu[p]), fs) for p in range(3)]
    irest = [smooth(mag(i_hv_pu[p]) + mag(i_lv_pu[p]), fs) for p in range(3)]
    calc = idiff + irest + [smooth(0.03 * x, fs) for x in idiff] + [smooth(0.01 * x, fs) for x in idiff]
    calc += [smooth(mag(np.sum(i_hv_pu, axis=0)) / 3, fs), smooth(mag(in_neutral) / in_hv, fs)]
    calc += [np.ones(n), np.zeros(n), np.full(n, 0.8 if kind == "interna" else 0.0) * fault, smooth(mag(i_hv_pu[0]), fs)]

    analogs = []
    if layout == "rel42":
        for p, ph in enumerate("ABC"):
            analogs.append(Analog(f"COR_{ph}_{p + 1:03d}", ph, "A", 4000, 1, b1[p]))
        analogs.append(Analog("COR_N_004", "N", "A", 800, 1, res_b))
        for p, ph in enumerate("ABC"):
            analogs.append(Analog(f"COR_{ph}_{p + 5:03d}", ph, "A", 4000, 1, b2[p]))
        for p, ph in enumerate("ABC"):
            analogs.append(Analog(f"COR_{ph}_{p + 8:03d}", ph, "A", 3000, 1, hv_i[p]))
        analogs.append(Analog("COR_N_011", "N", "A", 150, 1, neu))
        for p, ph in enumerate("ABC"):
            analogs.append(Analog(f"TEN_{ph}_{p + 12:03d}", ph, "V", 500e3, 115, hv_v[p]))
        for p, ph in enumerate("ABC"):
            analogs.append(Analog(f"COR_{ph}_{p + 15:03d}", ph, "A", 3000, 1, lv_i[p]))
        analogs.append(Analog("COR_N_018", "N", "A", 150, 1, inst(lv_neutral, t)))
        for p, ph in enumerate("ABC"):
            analogs.append(Analog(f"TEN_{ph}_{p + 19:03d}", ph, "V", 34.5e3, 115, lv_v[p]))
        for p, ph in enumerate("ABC"):
            analogs.append(Analog(f"TEN_{ph}_{p + 22:03d}", ph, "V", 34.5e3, 115, lv_v2[p]))
        for k, x in enumerate(calc):
            analogs.append(Analog(f"CALC_X_{k + 25:03d}", "", "I/IrObj", 0.01, 0.01, x))
        n_dig, normal = 128, 1
    else:
        for p, ph in enumerate("ABC"):
            analogs.append(Analog(f"COR_{ph}_{p + 1:03d}", ph, "A", 4000, 1, b1[p]))
        analogs.append(Analog("COR_N_004", "N", "A", 800, 1, res_b))
        for p, ph in enumerate("ABC"):
            analogs.append(Analog(f"COR_{ph}_{p + 5:03d}", ph, "A", 4000, 1, b2[p]))
        analogs.append(Analog("COR_E_008", "IE", "A", 4000, 1, res_b))
        for p, ph in enumerate("ABC"):
            analogs.append(Analog(f"COR_{ph}_{p + 9:03d}", ph, "A", 3000, 1, hv_i[p]))
        analogs.append(Analog("COR_N_012", "N", "A", 150, 1, neu))
        for p, ph in enumerate("ABC"):
            analogs.append(Analog(f"TEN_{ph}_{p + 13:03d}", ph, "V", 500e3, 115, hv_v[p]))
        for p, ph in enumerate("ABC"):
            analogs.append(Analog(f"COR_{ph}_{p + 16:03d}", ph, "A", 3000, 1, lv_i[p]))
        analogs.append(Analog("COR_N_019", "N", "A", 150, 1, inst(lv_neutral, t)))
        for p, ph in enumerate("ABC"):
            analogs.append(Analog(f"TEN_{ph}_{p + 20:03d}", ph, "V", 34.5e3, 115, lv_v[p]))
        for p, ph in enumerate("ABC"):
            analogs.append(Analog(f"TEN_{ph}_{p + 23:03d}", ph, "V", 34.5e3, 115, lv_v2[p]))
        n_dig, normal = 115, 1

    # canais digitais
    named: list[tuple[str, np.ndarray]] = []
    if kind == "interna":
        named = [
            ("87T PARTIDA", mask(t, [(tf + 0.012, t_open + 0.020)])),
            ("87T OPERADO", mask(t, [(t_trip, t_open + 0.030)])),
            ("TRIP GERAL", mask(t, [(t_trip, t_open + 0.040)])),
            ("86T BLOQUEIO", mask(t, [(t_trip + 0.004, t[-1] + 1)])),
            ("50N PARTIDA", mask(t, [(tf + 0.015, t_open)])),
            ("DJ AT1 ABERTO", mask(t, [(t_open + 0.004, t[-1] + 1)])),
            ("DJ AT2 ABERTO", mask(t, [(t_open + 0.007, t[-1] + 1)])),
            ("DJ BT ABERTO", mask(t, [(t_open, t[-1] + 1)])),
        ]
    else:
        named = [
            ("51 BT PARTIDA", mask(t, [(tf + 0.018, tf + 0.160)])),
            ("50/51 ALIMENTADOR TRIP", mask(t, [(tf + 0.095, tf + 0.170)])),
            ("87T PARTIDA", np.zeros(n, np.uint8)),
            ("87T OPERADO", np.zeros(n, np.uint8)),
            ("TRIP GERAL", np.zeros(n, np.uint8)),
            ("DJ ALIMENTADOR ABERTO", mask(t, [(tf + 0.150, t[-1] + 1)])),
        ]
    digitals = [Digital(nm, v, 0) for nm, v in named]
    for k in range(len(named), n_dig):
        digitals.append(Digital(f"EST_{k + 1:03d}", np.zeros(n, np.uint8), normal))
    return t, analogs, digitals, tf


# ---------------------------------------------------------------------------
# 2) Registrador de perturbação 16 kHz – energização com inrush + falta interna
# ---------------------------------------------------------------------------
def recorder_inrush_event(fs: float = 16000.0, dur: float = 3.0):
    n = int(fs * dur)
    t = np.arange(n) / fs
    t_close, t_fault, t_trip, t_open = 0.30, 1.80, 1.818, 1.858
    vn = 400e3 / np.sqrt(3)
    abc = np.array([1, A**2, A])

    def three(ph, rms, ang_deg=0.0):
        return [rms * np.exp(1j * np.radians(ang_deg)) * abc[p] * np.ones(n) for p in range(3)]

    # tensões das barras (afundamento durante a falta B-C no trafo)
    dip = (t >= t_fault) & (t < t_open)
    v_bus = [vn * abc[p] * np.ones(n) for p in range(3)]
    for p in (1, 2):
        v_bus[p] = np.where(dip, v_bus[p] * 0.72 * np.exp(1j * np.radians(-8 if p == 1 else 8)), v_bus[p])
    v1 = [inst(v, t) for v in v_bus]
    v2 = [inst(v * 0.995, t) for v in v_bus]

    # vãos de linha com carga
    def line_bay(rms, ang, fault_gain):
        ph = three(None, rms, ang)
        out = []
        for p in range(3):
            x = inst(ph[p], t)
            if p in (1, 2):
                extra = inst(np.where(dip, ph[p] * (fault_gain - 1), 0), t)
                x = dc_offset(x + extra, t, t_fault, 0.045, pre=x)
            out.append(x)
        return out

    bay1 = line_bay(620, -18, 3.2)
    bay4 = line_bay(410, -24, 2.1)
    bay5 = line_bay(530, -15, 2.6)
    bay6 = line_bay(300, -30, 1.4)

    # trafo: energização pelo AT (inrush) e falta interna B-C
    tr = t - t_close
    on = t >= t_close
    inrush = []
    for p, (flux_res, sign) in enumerate([(0.75, 1), (-0.55, -1), (-0.2, 1)]):
        theta = W * tr + np.radians(-120 * p)
        env = np.exp(-np.clip(tr, 0, None) / 0.45)
        pulse = np.clip(np.cos(theta) + flux_res, 0, None) ** 2.5  # semiciclos unipolares (saturação)
        x = sign * 1800.0 * env * pulse
        x += inst(25.0 * np.exp(-1j * np.radians(85)) * abc[p] * np.ones(n), t)  # magnetização
        inrush.append(np.where(on, x, 0.0))
    f_cur = 4200.0 * np.exp(-1j * np.radians(82))
    hv = []
    for p in range(3):
        x = inrush[p]
        if p in (1, 2):
            fx = inst(np.where(t >= t_fault, f_cur * (1 if p == 1 else -1) * np.ones(n), 0), t)
            x = dc_offset(x + fx, t, t_fault, 0.04, pre=x)
        hv.append(open_at_zero(x, t, t_open))
    lv = [np.zeros(n) for _ in range(3)]  # BT em vazio (trafo sendo energizado)

    analogs: list[Analog] = []
    num = [0]

    def add(name, ph, unit, prim, sec, x):
        num[0] += 1
        analogs.append(Analog(f"{name}_{ph or 'X'}_{num[0]:03d}", ph, unit, prim, sec, x))

    def add3(name, unit, prim, sec, xs, residual=True, resid_ph=""):
        for p, ph in enumerate("ABC"):
            add(name, ph, unit, prim, sec, xs[p])
        if residual:
            add(name, resid_ph, unit, prim, sec, sum(xs))

    add3("COR", "A", 1000, 1, bay1)                       # 1–4
    add3("TEN", "V", 400e3, 100, v1, False)               # 5–7
    add("TEN", "N", "V", 400e3, 173.4104, sum(v1))        # 8
    add3("COR", "A", 1000, 1, hv, True, "N")              # 9–12  trafo AT
    add3("COR", "A", 1000, 1, lv)                         # 13–16 trafo BT
    add3("COR", "A", 1000, 1, bay4)                       # 17–20
    add3("TEN", "V", 400e3, 100, v2, False)               # 21–23
    add("TEN", "N", "V", 400e3, 173.4104, sum(v2))        # 24
    add("COR", "", "A", 1000, 1, sum(bay1) - sum(bay4))   # 25
    add3("COR", "A", 1000, 1, bay5)                       # 26–29
    add3("COR", "A", 1000, 1, bay6)                       # 30–33
    freq = 60.0 + 0.004 * np.sin(2 * np.pi * 0.3 * t) - 0.03 * dip
    add("FREQ", "", "Hz", 100, 100, freq)                 # 34
    add3("TEN", "V", 400e3, 100, v1, False)               # 35–37
    add3("TEN", "V", 400e3, 100, v2, False)               # 38–40
    add("FREQ", "", "Hz", 100, 100, freq)                 # 41

    named = [
        ("DJ TRAFO FECHADO", mask(t, [(t_close, t_open + 0.004)])),
        ("87T PARTIDA", mask(t, [(t_close + 0.010, t_close + 0.85), (t_fault + 0.010, t_open + 0.02)])),
        ("87T BLOQ 2A HARM", mask(t, [(t_close + 0.012, t_close + 0.85)])),
        ("87T OPERADO", mask(t, [(t_trip, t_open + 0.03)])),
        ("TRIP GERAL", mask(t, [(t_trip, t_open + 0.04)])),
        ("86T BLOQUEIO", mask(t, [(t_trip + 0.004, dur + 1)])),
        ("DJ TRAFO ABERTO", mask(t, [(0, t_close), (t_open + 0.004, dur + 1)])),
    ]
    digitals = [Digital(nm, v, 0) for nm, v in named]
    for k in range(len(named), 45):
        digitals.append(Digital(f"EST_{k + 1:03d}", np.zeros(n, np.uint8), 0))
    return t, analogs, digitals, t_close


# ---------------------------------------------------------------------------
# 3) Linha 500 kV – oscilação de potência estável e perda de sincronismo
# ---------------------------------------------------------------------------
def power_swing_event(fs: float = 2000.0, dur: float = 10.0):
    n = int(fs * dur)
    t = np.arange(n) / fs
    vn = 500e3 / np.sqrt(3)
    zs, zl, zr = 4 + 45j, 6 + 75j, 5 + 50j  # Ω primários (fonte local, linha, fonte remota)
    # ângulo entre as fontes: carga 25°; perturbação em 1,0 s → oscilação amortecida;
    # nova perturbação em 5,0 s → escorregamento crescente (perda de sincronismo)
    delta = np.full(n, 25.0)
    m1 = (t >= 1.0) & (t < 5.0)
    tt = t[m1] - 1.0
    delta[m1] = 25 + 70 * np.sin(2 * np.pi * 0.7 * tt) * np.exp(-0.35 * tt)
    m2 = t >= 5.0
    tt = t[m2] - 5.0
    slip_hz = np.minimum(0.4 + 0.45 * tt, 2.2)
    delta[m2] = delta[m1][-1] + np.degrees(np.cumsum(2 * np.pi * slip_hz) / fs)
    es = vn * np.ones(n)
    er = 0.98 * vn * np.exp(-1j * np.radians(delta))
    i1 = (es - er) / (zs + zl + zr)
    v1 = es - zs * i1
    t_oos = None
    # trip OOS na 2ª travessia do centro elétrico (δ ≈ 180° + 360°)
    cross = np.flatnonzero((np.mod(delta - 180, 360)[1:] < np.mod(delta - 180, 360)[:-1]) & m2[1:])
    if len(cross) >= 2:
        t_oos = t[cross[1]] + 0.02
    abc = np.array([1, A**2, A])
    ia = [inst(i1 * abc[p], t) for p in range(3)]
    va = [inst(v1 * abc[p], t) for p in range(3)]
    if t_oos:
        ia = [open_at_zero(x, t, t_oos + 0.04) for x in ia]
    analogs = [Analog(f"TEN_{ph}_{p + 1:03d}", ph, "V", 500e3, 115, va[p]) for p, ph in enumerate("ABC")]
    analogs += [Analog(f"COR_{ph}_{p + 4:03d}", ph, "A", 2000, 1, ia[p]) for p, ph in enumerate("ABC")]
    analogs.append(Analog("COR_N_007", "N", "A", 2000, 1, sum(ia)))
    f_dev = np.gradient(np.unwrap(np.radians(delta))) * fs / (2 * np.pi)
    analogs.append(Analog("FREQ_X_008", "", "Hz", 100, 100, 60.0 - 0.5 * f_dev))

    zmag = np.abs(v1 / np.where(np.abs(i1) > 1, i1, np.nan))
    psb = np.nan_to_num(zmag) < 160
    named = [
        ("68 PSB ATIVO", (psb & (t > 1.0) & (t < (t_oos or dur))).astype(np.uint8)),
        ("78 OOS TRIP", mask(t, [(t_oos, t_oos + 0.1)]) if t_oos else np.zeros(n, np.uint8)),
        ("21 Z1 PARTIDA", np.zeros(n, np.uint8)),
        ("21 Z2 PARTIDA", ((zmag < 110) & (t < (t_oos or dur))).astype(np.uint8)),
        ("TRIP GERAL", mask(t, [(t_oos, t_oos + 0.12)]) if t_oos else np.zeros(n, np.uint8)),
        ("DJ LINHA ABERTO", mask(t, [(t_oos + 0.045, dur + 1)]) if t_oos else np.zeros(n, np.uint8)),
    ]
    digitals = [Digital(nm, v, 0) for nm, v in named]
    for k in range(len(named), 16):
        digitals.append(Digital(f"EST_{k + 1:03d}", np.zeros(n, np.uint8), 0))
    return t, analogs, digitals, 1.0


# ---------------------------------------------------------------------------
def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", default=str(Path(__file__).resolve().parent.parent / "samples"))
    out = Path(parser.parse_args().out)

    t, an, dg, tf = transformer_relay_event(2000.0, 12761, "interna", "rel42")
    rec = Record("IED_DEMO_003", 2000.0, t, tf, an, dg)
    rec.write(out / "demo_falta_transformador", "BINARY", "2013")
    rec.write_hdr(out / "demo_falta_transformador", "Falta interna fase A-terra nos terminais AT do transformador 500/34,5 kV",
                  "Transformador 150 MVA YNd1. Protecao diferencial 87T atua em ~20 ms; disjuntores AT (disjuntor-e-meio) e BT abrem em ~62 ms.")
    (out / "demo_falta_transformador" / "registro.inf").write_text(
        "[Oscilo sample]\r\nsynthetic=1\r\ngenerator=scripts/generate_samples.py\r\nscenario=falta interna AT\r\n", encoding="ascii")

    t, an, dg, tf = transformer_relay_event(2000.0, 12054, "externa", "exp25")
    Record("IED_DEMO_002", 2000.0, t, tf, an, dg).write(out / "demo_87t_exportacao", "ASCII", "2013")

    t, an, dg, tf = recorder_inrush_event()
    Record("IED_DEMO_001", 16000.0, t, tf, an, dg).write(out / "demo_87t_diferencial", "BINARY", "1997")

    t, an, dg, tf = power_swing_event()
    rec = Record("IED_DEMO_004", 2000.0, t, tf, an, dg)
    rec.write(out / "demo_oscilacao_potencia", "FLOAT32", "2013")
    rec.write_hdr(out / "demo_oscilacao_potencia", "Oscilacao de potencia estavel seguida de perda de sincronismo",
                  "Linha 500 kV, modelo de duas maquinas. Oscilacao amortecida (0,7 Hz) a partir de 1,0 s; "
                  "nova perturbacao em 5,0 s leva ao escorregamento crescente e trip por OOS.")

    for d in sorted(out.iterdir()):
        if d.is_dir():
            size = sum(f.stat().st_size for f in d.iterdir())
            print(f"{d.name:28s} {size / 1e6:6.2f} MB")


if __name__ == "__main__":
    main()
