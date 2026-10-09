"""Release-tooling adapter to the same bounded archive reader as the fixed helper."""
import importlib.util
import json
from pathlib import Path
import sys
sys.dont_write_bytecode = True

source = Path(__file__).resolve().parents[1] / 'packages/electron/update/updater-helper.py'
spec = importlib.util.spec_from_file_location('helper', source)
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)
print(json.dumps(helper.package_identity(sys.argv[1])))
