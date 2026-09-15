#!/usr/bin/env python3
"""patch-mlx-toolparser.py — der Qwen3-Coder-Werkzeugparser von mlx-lm und mlx-vlm verschluckt
Werkzeugaufrufe, deren Argumente kein striktes JSON sind. Dieser Patch macht ihn nachsichtig.

  patch-mlx-toolparser.py pruefen    Exit 0 = Patch sitzt in jedem gefundenen Werkzeug, sonst 1
  patch-mlx-toolparser.py anwenden   Patch einsetzen (idempotent), Sicherung als *.orig daneben
  patch-mlx-toolparser.py zurueck    Original aus *.orig zurueckholen

ANLASS (2026-09-10, live gemessen an einem qwen38-Worker, 72k Kontext): Der Worker endete
Zug um Zug mit Denken plus leerem Text und ohne Werkzeugaufruf, obwohl der Server je Zug rund
1000 Ausgabe-Token erzeugt hatte. Im Server-Log stand der Grund:

    File ".../mlx_lm/tool_parsers/qwen3_coder.py", line 77, in _convert_param_value
        return ast.literal_eval(param_value)
    SyntaxError: closing parenthesis ')' does not match opening parenthesis '{'

Das Modell hatte `edit` mit einer `edits`-Liste aufgerufen, deren `oldText` rohe Zeilenumbrueche
und Klammern enthielt. `_convert_param_value` versucht fuer Listen- und Objektparameter
`json.loads` (scheitert an rohen Zeilenumbruechen in Zeichenketten, die striktes JSON verbietet)
und faellt dann OHNE Ausnahmebehandlung auf `ast.literal_eval` zurueck, das an dem Text mit
SyntaxError abbricht. Die ganze Anfrage stirbt, pi sieht eine leere Antwort mit stopReason
`stop`, der Worker versucht dieselbe Bearbeitung erneut, gleicher Absturz — eine Schleife, die
von aussen wie „das Modell will nicht arbeiten" aussieht. Es ist der Server.

WAS DER PATCH TUT: In `_convert_param_value` wird die Kette nachsichtig:
    json.loads(strict)  ->  json.loads(strict=False, erlaubt Steuerzeichen in Strings)
    ->  ast.literal_eval  ->  Rohwert als Zeichenkette.
Der Rohwert als letzte Stufe heisst: der Werkzeugaufruf kommt beim Harness an, und das
Werkzeug meldet dem Modell einen sauberen Argumentfehler, statt dass die Anfrage stirbt.

WO ER SITZT: in den uv-Werkzeugen `~/.local/share/uv/tools/mlx-lm` und `.../mlx-vlm`, nicht
im Repo — wie der APC-Speicher-Patch (shell/messungen/apc-speicher/patch-apc-speicher.py).
Nach jedem `uv tool install mlx-lm` oder `mlx-vlm` neu anwenden; `pruefen` sagt, ob er fehlt.

Reproduktion ohne Modell (vor dem Patch SyntaxError, danach ein dict):
    python - <<'EOF'
    from mlx_lm.tool_parsers import qwen3_coder as q
    tools=[{"type":"function","function":{"name":"edit","parameters":{"type":"object",
      "properties":{"edits":{"type":"array"}}}}}]
    raw='<function=edit>\\n<parameter=edits>\\n[{"oldText": "a (b)\\nc"}]\\n</parameter>\\n</function>'
    print(q.parse_tool_call(raw, tools))
    EOF
"""
import glob
import os
import shutil
import sys

HOME = os.path.expanduser("~")
KANDIDATEN = [
    f"{HOME}/.local/share/uv/tools/mlx-lm/lib/python*/site-packages/mlx_lm/tool_parsers/qwen3_coder.py",
    f"{HOME}/.local/share/uv/tools/mlx-vlm/lib/python*/site-packages/mlx_vlm/tool_parsers/qwen3_coder.py",
]
MARKE = "# wb-patch: nachsichtiger Werkzeugparser (patch-mlx-toolparser.py)"

ALT = '''            try:
                return json.loads(param_value)
            except json.JSONDecodeError:
                return ast.literal_eval(param_value)

        return ast.literal_eval(param_value)
'''

NEU = f'''            {MARKE}
            try:
                return json.loads(param_value)
            except json.JSONDecodeError:
                try:
                    return json.loads(param_value, strict=False)
                except json.JSONDecodeError:
                    try:
                        return ast.literal_eval(param_value)
                    except Exception:
                        return param_value

        try:
            return ast.literal_eval(param_value)
        except Exception:
            return param_value
'''


def dateien():
    gefunden = []
    for muster in KANDIDATEN:
        gefunden.extend(sorted(glob.glob(muster)))
    return gefunden


def pruefen():
    ds = dateien()
    if not ds:
        print("patch-mlx-toolparser: kein qwen3_coder.py in den uv-Werkzeugen gefunden.")
        return 1
    rc = 0
    for d in ds:
        s = open(d, encoding="utf-8").read()
        if MARKE in s:
            print(f"  gepatcht: {d}")
        elif ALT in s:
            print(f"  FEHLT:    {d}")
            rc = 1
        else:
            print(f"  UNBEKANNT (weder Original noch Patch erkannt): {d}")
            rc = 1
    return rc


def anwenden():
    rc = 0
    for d in dateien():
        s = open(d, encoding="utf-8").read()
        if MARKE in s:
            print(f"  schon gepatcht: {d}")
            continue
        if ALT not in s:
            print(f"  UNBEKANNT, nicht angefasst: {d}")
            rc = 1
            continue
        sicherung = d + ".orig"
        if not os.path.exists(sicherung):
            shutil.copy2(d, sicherung)
        open(d, "w", encoding="utf-8").write(s.replace(ALT, NEU, 1))
        for pyc in glob.glob(os.path.join(os.path.dirname(d), "__pycache__", "qwen3_coder*.pyc")):
            os.remove(pyc)
        print(f"  gepatcht: {d}  (Sicherung {sicherung})")
    return rc


def zurueck():
    rc = 0
    for d in dateien():
        sicherung = d + ".orig"
        if os.path.exists(sicherung):
            shutil.copy2(sicherung, d)
            print(f"  zurueck: {d}")
        else:
            print(f"  keine Sicherung: {d}")
            rc = 1
    return rc


if __name__ == "__main__":
    befehl = sys.argv[1] if len(sys.argv) > 1 else ""
    if befehl == "pruefen":
        sys.exit(pruefen())
    if befehl == "anwenden":
        sys.exit(anwenden())
    if befehl == "zurueck":
        sys.exit(zurueck())
    print(__doc__.strip().splitlines()[0])
    print("  pruefen | anwenden | zurueck")
    sys.exit(2)
