"""Tiny TOML writer for the config shapes we produce (tables, arrays of
tables, strings, numbers, booleans, lists of strings)."""

import json


def _val(v):
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, (int, float)):
        return repr(v)
    if isinstance(v, str):
        return json.dumps(v)  # JSON string escapes are valid TOML basic strings
    if isinstance(v, list):
        return "[" + ", ".join(_val(x) for x in v) + "]"
    raise TypeError(f"can't write {type(v).__name__} to TOML")


def dumps(cfg, header=""):
    out = [header] if header else []
    for sec, body in cfg.items():
        scalars = {k: v for k, v in body.items() if not (isinstance(v, list) and v and isinstance(v[0], dict))}
        tables = {k: v for k, v in body.items() if k not in scalars}
        out.append(f"[{sec}]")
        for k, v in scalars.items():
            out.append(f"{k} = {_val(v)}")
        out.append("")
        for k, rows in tables.items():
            for row in rows:
                out.append(f"[[{sec}.{k}]]")
                for rk, rv in row.items():
                    out.append(f"{rk} = {_val(rv)}")
                out.append("")
    return "\n".join(out).rstrip() + "\n"
