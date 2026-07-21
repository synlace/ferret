import sys
import json
import argparse

def format_list(data):
    headers = ["ID", "Name", "Max Runners"]
    rows = []
    for d in data:
        rows.append([
            d.get("id") or "",
            d.get("name") or "",
            str(d.get("den_max_runners") or d.get("max_runners") or ""),
        ])
    col_widths = [max(len(h), max(len(row[i]) for row in rows)) for i, h in enumerate(headers)]
    col_fmt = "  ".join("%-" + str(w) + "s" for w in col_widths)

    print(col_fmt % tuple(headers))
    print("  ".join("-" * w for w in col_widths))
    for r in rows:
        print(col_fmt % tuple(r))

def format_info(d):
    fields = [
        ("ID", d.get("id") or ""),
        ("Name", d.get("name") or ""),
        ("Max Runners", str(d.get("den_max_runners") or d.get("max_runners") or "")),
    ]
    fields = [f for f in fields if f[1] or f[0] in ("ID", "Name")]
    
    col_widths = [max(len(f[0]) for f in fields), max(len(f[1]) for f in fields)]
    col_fmt = "  ".join("%-" + str(w) + "s" for w in col_widths)
    
    print(col_fmt % ("Field", "Value"))
    print("  ".join("-" * w for w in col_widths))
    for f in fields:
        print(col_fmt % f)

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--mode", choices=["list", "info"], default="info")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()

    try:
        data = json.load(sys.stdin)
    except Exception:
        print("Failed to parse JSON. Is the API running?")
        sys.exit(1)

    if isinstance(data, dict) and "detail" in data:
        print(f"Error: {data['detail']}")
        sys.exit(1)

    if args.json:
        print(json.dumps(data, indent=4))
        sys.exit(0)

    if args.mode == "list":
        if not isinstance(data, list):
            data = [data]
        format_list(data)
    else:
        if isinstance(data, list):
            if not data:
                print("No den found.")
                sys.exit(0)
            data = data[0]
        format_info(data)

if __name__ == "__main__":
    main()