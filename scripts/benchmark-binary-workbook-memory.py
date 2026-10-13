"""Measure current or before/after native artifact memory for a binary workbook.

Windows reports the kernel-recorded peak working set and sampled private
bytes; filesystem caches are not flushed. This script runs only the supplied
parser binaries and stores each artifact and log under the output directory.
"""

import argparse
import ctypes
from ctypes import wintypes
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import time


class MemoryCounters(ctypes.Structure):
    _fields_ = [
        ("cb", wintypes.DWORD),
        ("PageFaultCount", wintypes.DWORD),
        ("PeakWorkingSetSize", ctypes.c_size_t),
        ("WorkingSetSize", ctypes.c_size_t),
        ("QuotaPeakPagedPoolUsage", ctypes.c_size_t),
        ("QuotaPagedPoolUsage", ctypes.c_size_t),
        ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t),
        ("QuotaNonPagedPoolUsage", ctypes.c_size_t),
        ("PagefileUsage", ctypes.c_size_t),
        ("PeakPagefileUsage", ctypes.c_size_t),
        ("PrivateUsage", ctypes.c_size_t),
    ]


def sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for data in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(data)
    return digest.hexdigest()


def is_scratch(path):
    return path.suffix == ".scratch" or path.name.endswith((".sst.bin", ".sst.idx", ".formulas.bin"))


def scratch_files(directory):
    return [path for path in directory.iterdir() if path.is_file() and is_scratch(path)]


def measure(parser, source, output, label):
    directory = output / label
    directory.mkdir(parents=True, exist_ok=True)
    get_memory = ctypes.WinDLL("psapi", use_last_error=True).GetProcessMemoryInfo
    get_memory.argtypes = [wintypes.HANDLE, ctypes.POINTER(MemoryCounters), wintypes.DWORD]
    get_memory.restype = wintypes.BOOL
    peaks = {"workingSetBytes": 0, "privateBytes": 0}
    peak_scratch = 0
    peak_output = 0
    next_disk_sample = 0
    started = time.perf_counter()
    with (directory / "stdout.log").open("wb") as stdout:
        with (directory / "stderr.log").open("wb") as stderr:
            process = subprocess.Popen(
                [str(parser), "--prepare-artifact", str(source), str(source), str(directory)],
                stdout=stdout, stderr=stderr, creationflags=subprocess.CREATE_NO_WINDOW,
            )
            while True:
                counters = MemoryCounters()
                counters.cb = ctypes.sizeof(counters)
                if get_memory(int(process._handle), ctypes.byref(counters), counters.cb):
                    peaks["workingSetBytes"] = max(peaks["workingSetBytes"], counters.PeakWorkingSetSize)
                    peaks["privateBytes"] = max(peaks["privateBytes"], counters.PrivateUsage)
                if time.perf_counter() >= next_disk_sample:
                    scratch_bytes = 0
                    output_bytes = 0
                    for path in directory.iterdir():
                        try:
                            if path.is_file():
                                size = path.stat().st_size
                                output_bytes += size
                                if is_scratch(path):
                                    scratch_bytes += size
                        except FileNotFoundError:
                            pass  # A completed run can be removed between listing and stat.
                    peak_scratch = max(peak_scratch, scratch_bytes)
                    peak_output = max(peak_output, output_bytes)
                    next_disk_sample = time.perf_counter() + 0.2
                if process.poll() is not None:
                    break
                if time.perf_counter() - started > 600:
                    process.kill()
                    process.wait()
                    raise RuntimeError("Native binary benchmark exceeded 600 seconds")
                time.sleep(0.02)
    result = {
        "parser": str(parser), "parserSha256": sha256(parser),
        "elapsedSeconds": time.perf_counter() - started,
        "exitCode": process.returncode, "peaks": peaks,
        "sampledPeakScratchBytes": peak_scratch,
        "sampledPeakOutputBytes": peak_output,
    }
    if process.returncode:
        raise RuntimeError((directory / "stderr.log").read_text(encoding="utf-8"))
    result["manifest"] = json.loads((directory / "manifest.json").read_text(encoding="utf-8"))
    remaining = scratch_files(directory)
    if remaining:
        raise RuntimeError(f"Scratch files remain after completion: {remaining}")
    result["scratchRemoved"] = True
    result["finalArtifactBytes"] = sum(path.stat().st_size for path in directory.iterdir()
                                       if path.suffix in (".bin", ".idx"))
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--current", type=Path)
    parser.add_argument("--before", type=Path)
    parser.add_argument("--after", type=Path)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    options = parser.parse_args()
    if options.current:
        if options.before or options.after:
            parser.error("--current cannot be combined with --before or --after")
    elif not options.before or not options.after:
        parser.error("Supply --current, or both --before and --after")
    if sys.platform != "win32":
        parser.error("This benchmark uses Windows native process memory counters")
    output = options.output.resolve()
    source = options.source.resolve()
    results = {
        "source": str(source), "sourceSha256": sha256(source),
        "sourceBytes": source.stat().st_size,
        "cachePolicy": "OS filesystem cache not flushed",
        "sampling": "20 ms sampled private bytes; kernel peak working set; 200 ms sampled scratch bytes",
    }
    if options.current:
        results["current"] = measure(options.current.resolve(), source, output, "current")
    else:
        results["cachePolicy"] += "; before then after"
        results["before"] = measure(options.before.resolve(), source, output, "before")
        results["after"] = measure(options.after.resolve(), source, output, "after")
        artifact_names = {
            file.name
            for label in ("before", "after")
            for file in (output / label).iterdir()
            if file.suffix in (".bin", ".idx")
        }
        results["identicalArtifactFiles"] = {}
        for name in sorted(artifact_names):
            before = output / "before" / name
            after = output / "after" / name
            results["identicalArtifactFiles"][name] = (
                before.exists() and after.exists() and sha256(before) == sha256(after)
            )
        before_manifest = {key: value for key, value in results["before"]["manifest"].items() if key not in ("artifactDir", "perf")}
        after_manifest = {key: value for key, value in results["after"]["manifest"].items() if key not in ("artifactDir", "perf")}
        results["identicalManifestSemantics"] = before_manifest == after_manifest
    (output / "result.json").write_text(json.dumps(results, indent=2), encoding="utf-8")
    summary = {
        key: value for key, value in results.items()
        if key not in ("current", "before", "after")
    }
    for label in ("current", "before", "after"):
        if label in results:
            summary[label] = {
                key: value for key, value in results[label].items() if key != "manifest"
            }
    summary["resultPath"] = str(output / "result.json")
    print(json.dumps(summary, indent=2))
    if not all(results.get("identicalArtifactFiles", {}).values()):
        raise RuntimeError("Native artifact data changed between before and after binaries")
    if results.get("identicalManifestSemantics") is False:
        raise RuntimeError("Native artifact manifest semantics changed between binaries")


if __name__ == "__main__":
    main()
