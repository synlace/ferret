import sys
import json
import datetime

def main():
    try:
        data = json.load(sys.stdin)
    except Exception as e:
        print("Error parsing runner JSON:", e)
        return

    if not data:
        print("No active registered runners found.")
        return

    headers = ["RUNNER ID", "TYPE", "LAST SEEN", "STATUS"]
    rows = []
    for d in data:
        rid = d.get("id") or "N/A"
        rtype = "Local"
        
        # Last seen formatting
        last_seen_epoch = d.get("last_seen", 0)
        if last_seen_epoch:
            dt = datetime.datetime.fromtimestamp(last_seen_epoch)
            last_seen_str = dt.strftime("%Y-%m-%d %H:%M:%S")
            age_sec = int(datetime.datetime.now().timestamp() - last_seen_epoch)
            if age_sec < 35:
                status = "Online"
            else:
                status = "Stale"
        else:
            last_seen_str = "Never"
            status = "Unknown"
            
        rows.append([rid, rtype, last_seen_str, status])

    # Dynamic column widths
    col_widths = [max(len(h), max(len(row[i]) for row in rows)) for i, h in enumerate(headers)]
    col_fmt = "  ".join("%-" + str(w) + "s" for w in col_widths)

    print(col_fmt % tuple(headers))
    print("  ".join("-" * w for w in col_widths))
    for r in rows:
        # Add color to status if supported by stdout
        status = r[3]
        if sys.stdout.isatty():
            if status == "Online":
                r[3] = "\033[32mOnline\033[0m"
            elif status == "Stale":
                r[3] = "\033[33mStale\033[0m"
        print(col_fmt % tuple(r))

if __name__ == "__main__":
    main()
