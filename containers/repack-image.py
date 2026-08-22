#!/usr/bin/env python3
import os
import shutil
import stat

ROOT = "/"
OUT = "/chunks"
CHUNK_BYTES = 96 * 1024 * 1024
CHUNK_COUNT = 64
SKIP = {"/chunks", "/dev", "/proc", "/sys", "/root/.cache"}

for index in range(CHUNK_COUNT):
    os.makedirs(f"{OUT}/{index:02d}", exist_ok=True)

groups = {}
directories = []
symlinks = []
for base, names, files in os.walk(ROOT, topdown=True, followlinks=False):
    names[:] = [name for name in names if os.path.join(base, name) not in SKIP]
    if base in SKIP:
        continue
    directories.append(base)
    for name in names + files:
        path = os.path.join(base, name)
        if path in SKIP:
            continue
        info = os.lstat(path)
        if stat.S_ISLNK(info.st_mode):
            symlinks.append(path)
        elif stat.S_ISREG(info.st_mode):
            groups.setdefault((info.st_dev, info.st_ino), []).append(path)

def destination(chunk, path):
    return f"{OUT}/{chunk:02d}{path}"

for path in sorted(directories, key=lambda value: (value.count("/"), value)):
    if path == ROOT:
        continue
    target = destination(0, path)
    info = os.lstat(path)
    os.makedirs(target, exist_ok=True)
    os.chmod(target, stat.S_IMODE(info.st_mode))

for path in symlinks:
    target = destination(0, path)
    os.makedirs(os.path.dirname(target), exist_ok=True)
    if not os.path.lexists(target):
        os.symlink(os.readlink(path), target)

chunk = 1
used = 0
for paths in sorted(groups.values(), key=lambda values: os.lstat(values[0]).st_size, reverse=True):
    size = os.lstat(paths[0]).st_size
    if used and used + size > CHUNK_BYTES:
        chunk += 1
        used = 0
    if chunk >= CHUNK_COUNT:
        raise RuntimeError("filesystem exceeds configured chunk count")
    first = destination(chunk, paths[0])
    os.makedirs(os.path.dirname(first), exist_ok=True)
    shutil.copy2(paths[0], first, follow_symlinks=False)
    for path in paths[1:]:
        target = destination(chunk, path)
        os.makedirs(os.path.dirname(target), exist_ok=True)
        os.link(first, target)
    used += size

print(f"repacked into {chunk + 1} chunks")
