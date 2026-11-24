#!/usr/bin/env python3
"""Point this build of PebbleKey at a sign-in service (see broker/), or at none.

    python3 tools/set_broker.py https://pebblekey.example.workers.dev
    python3 tools/set_broker.py --none

The address is needed in two places, and this keeps them in step:
  src/pkjs/broker.json  where the phone-side code reads it
  package.json          the Pebble phone app only lets a watchapp reach hosts listed there
"""

import json
import pathlib
import sys
import urllib.parse

ROOT = pathlib.Path(__file__).resolve().parent.parent
BROKER_FILE = ROOT / "src" / "pkjs" / "broker.json"
PACKAGE_FILE = ROOT / "package.json"
# Hosts the app always needs, whichever way it is set up.
VOLVO_HOSTS = ["auth.volvocars.com", "api.volvocars.com"]


def main() -> int:
    if len(sys.argv) != 2 or sys.argv[1] in ("-h", "--help"):
        print(__doc__)
        return 2

    url = ""
    hosts = list(VOLVO_HOSTS)
    if sys.argv[1] != "--none":
        parsed = urllib.parse.urlsplit(sys.argv[1].strip())
        if parsed.scheme != "https" or not parsed.hostname or parsed.path.strip("/") or parsed.query:
            print("Give the service's address like https://pebblekey.example.workers.dev")
            return 2
        url = "https://" + parsed.netloc
        hosts.append(parsed.hostname)

    BROKER_FILE.write_text(json.dumps({"url": url}, indent=2) + "\n")

    package = json.loads(PACKAGE_FILE.read_text())
    for permission in package["pebble"]["usesPermissions"]:
        if isinstance(permission, dict) and permission.get("name") == "Internet":
            permission["parameters"]["domains"] = hosts
            break
    else:
        print("package.json has no Internet permission to update")
        return 1
    PACKAGE_FILE.write_text(json.dumps(package, indent=2) + "\n")

    print("Sign-in service: " + (url or "none"))
    print("Now rebuild with: pebble build")
    return 0


if __name__ == "__main__":
    sys.exit(main())
