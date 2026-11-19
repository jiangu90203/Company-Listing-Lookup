"""Stage only public runtime assets; tests, scripts and local imports stay out."""
import shutil
from pathlib import Path

root = Path(__file__).resolve().parents[1]
target = root / '_site'
if target.exists():
    shutil.rmtree(target)
target.mkdir()
for name in ['index.html', '.nojekyll', 'assets', 'vendor', 'data', 'examples']:
    path = root / name
    if path.is_dir():
        shutil.copytree(path, target / name)
    else:
        shutil.copy2(path, target / name)
print('Static website staged in _site/')
