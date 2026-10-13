#!/usr/bin/python3
"""Online SQLite backups; private node identities stay in the private archive."""
from pathlib import Path
from datetime import datetime, timezone
import sqlite3
import shutil
import tempfile
import tarfile
import json

state = Path('/var/lib/ctrl-mesh/devnet')
destination = Path('/var/backups/ctrl-mesh')
destination.mkdir(mode=0o700, parents=True, exist_ok=True)
stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')
with tempfile.TemporaryDirectory(prefix='snapshot-', dir=destination) as directory:
    staging = Path(directory)
    (staging / 'devnet/ha').mkdir(parents=True, mode=0o700)
    for voter in 'abc':
        with sqlite3.connect(f'file:{state}/ha/{voter}.sqlite?mode=ro', uri=True) as source:
            with sqlite3.connect(staging / f'devnet/ha/{voter}.sqlite') as copy:
                source.backup(copy)
                if copy.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
                    raise RuntimeError(f'Invalid backup of voter {voter}')
        for role in ['sponsor', 'relay']:
            shutil.copy2(state / f'{role}-{voter}.json', staging / f'devnet/{role}-{voter}.json')
    for name in ['cluster.json', 'peer.token']:
        shutil.copy2(state / 'ha' / name, staging / 'devnet/ha' / name)
    shutil.copytree('/etc/ctrl-mesh', staging / 'config')
    release = Path('/opt/ctrl-mesh/current').resolve()
    shutil.copy2(release / 'manifest.json', staging / 'manifest.json')
    (staging / 'release.json').write_text(json.dumps({'release': str(release), 'created': stamp}) + '\n')
    final = destination / f'ctrl-mesh-{stamp}.tar.gz'
    temporary = final.with_suffix('.pending')
    with tarfile.open(temporary, 'w:gz') as archive:
        for path in staging.iterdir():
            archive.add(path, arcname=path.name)
    temporary.chmod(0o600)
    temporary.rename(final)
for old in sorted(destination.glob('ctrl-mesh-*.tar.gz'))[:-14]:
    old.unlink()
print(f'ctrl-mesh backup saved: {final.name}')
