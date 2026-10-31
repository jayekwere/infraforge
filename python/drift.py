"""Compare exported desired and observed JSON without cloud access or mutation."""
import json
import sys

def drift(desired, observed):
    keys = sorted(set(desired) | set(observed))
    return [{"field": k, "desired": desired.get(k), "observed": observed.get(k)}
            for k in keys if desired.get(k) != observed.get(k)]

if __name__ == '__main__':
    with open(sys.argv[1]) as stream:
        desired = json.load(stream)
    with open(sys.argv[2]) as stream:
        observed = json.load(stream)
    result = drift(desired, observed)
    print(json.dumps({"drift": result, "remediation": "manual review required"}, indent=2))
    sys.exit(bool(result))
