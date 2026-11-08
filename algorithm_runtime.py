"""Run explicitly trusted local algorithms using the documented on_bar contract.

Subprocesses bound normal runtime/output; they are NOT a security sandbox.
"""
import ast
import math
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time

RUN_LOCK = threading.Lock()
MAX_OUTPUT = 1_000_000
PYTHON_DRIVER = '''import importlib.util, sys
spec = importlib.util.spec_from_file_location("uploaded_strategy", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
history = []
for line in sys.stdin:
    values = [float(value) for value in line.split()]
    history.append(dict(zip(("open", "high", "low", "close", "volume"), values)))
    signal = module.on_bar([dict(bar) for bar in history])
    if signal not in ("buy", "sell", "hold"):
        raise ValueError("on_bar must return buy, sell, or hold")
    print(signal, flush=True)
'''
CPP_DRIVER = '''#include <iostream>
#include <vector>
#include <string>
struct Bar { double open, high, low, close, volume; };
#include "strategy.cpp"
int main() {
    std::vector<Bar> history;
    Bar bar;
    while (std::cin >> bar.open >> bar.high >> bar.low >> bar.close >> bar.volume) {
        history.push_back(bar);
        std::string signal = on_bar(history);
        if (signal != "buy" && signal != "sell" && signal != "hold") return 2;
        std::cout << signal << std::endl;
    }
}
'''


def validate_native_program(program):
    if not isinstance(program, dict) or set(program) != {"language", "source", "direction"}:
        raise ValueError("Invalid executable algorithm.")
    language, source = program["language"], program["source"]
    if language not in ("python", "cpp") or program["direction"] != "long":
        raise ValueError("Python/C++ algorithms currently support long-only buy/sell signals.")
    if not isinstance(source, str) or not source.strip() or len(source.encode("utf-8")) > 100_000:
        raise ValueError("Algorithm source must contain 1–100,000 UTF-8 bytes.")
    if language == "python":
        try:
            tree = ast.parse(source)
        except (SyntaxError, RecursionError) as exc:
            raise ValueError(f"Invalid Python source: {exc}") from exc
        functions = [node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == "on_bar"]
        if len(functions) != 1 or len(functions[0].args.posonlyargs + functions[0].args.args) != 1:
            raise ValueError("Python must define on_bar(bars), returning 'buy', 'sell', or 'hold'. Download the example for the interface.")
    elif not re.search(r"\bon_bar\s*\(", source):
        raise ValueError("C++ must define std::string on_bar(const std::vector<Bar>& bars). Download the example for the interface.")
    return dict(program)


def bounded_process(command, directory, stdin_path, timeout):
    with stdin_path.open("rb") as stdin, (directory / "stdout").open("w+b") as stdout, (directory / "stderr").open("w+b") as stderr:
        process = subprocess.Popen(command, cwd=directory, stdin=stdin, stdout=stdout, stderr=stderr,
                                   creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
        deadline = time.monotonic() + timeout
        try:
            while process.poll() is None:
                if time.monotonic() >= deadline:
                    raise ValueError(f"Algorithm exceeded the {timeout}-second execution limit.")
                if os.fstat(stdout.fileno()).st_size + os.fstat(stderr.fileno()).st_size > MAX_OUTPUT:
                    raise ValueError("Algorithm output exceeded 1 MB. Remove debug printing.")
                time.sleep(0.02)
            if os.fstat(stdout.fileno()).st_size + os.fstat(stderr.fileno()).st_size > MAX_OUTPUT:
                raise ValueError("Algorithm output exceeded 1 MB.")
            stderr.seek(0)
            error = stderr.read(4000).decode("utf-8", errors="replace")
            if process.returncode:
                raise ValueError(f"Algorithm failed (exit {process.returncode}): {error or 'check the on_bar return value'}")
            stdout.seek(0)
            return stdout.read(MAX_OUTPUT).decode("utf-8", errors="replace")
        finally:
            if process.poll() is None:
                process.kill()
            process.wait()


def run_algorithm(program, bars, trusted=False):
    program = validate_native_program(program)
    if trusted is not True:
        raise ValueError("Confirm that you trust this source before running local Python/C++ code.")
    if not isinstance(bars, list) or not 1 <= len(bars) <= 5000:
        raise ValueError("Algorithms require 1–5,000 chronological bars.")
    rows = []
    for bar in bars:
        if not isinstance(bar, dict):
            raise ValueError("Invalid algorithm bar.")
        values = [bar.get(key, 0 if key == "volume" else None) for key in ("open", "high", "low", "close", "volume")]
        if any(isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v) for v in values):
            raise ValueError("Algorithm bars must contain finite OHLCV values.")
        if min(values[:4]) <= 0 or values[4] < 0 or values[1] < max(values[0], values[2], values[3]) or values[2] > min(values[0], values[3]):
            raise ValueError("Invalid OHLCV price range.")
        rows.append(" ".join(str(value) for value in values))
    if not RUN_LOCK.acquire(blocking=False):
        raise ValueError("Another local algorithm is running. Retry when it finishes.")
    try:
        with tempfile.TemporaryDirectory(prefix="session-algorithm-") as temp:
            directory = Path(temp)
            data = directory / "bars.txt"
            data.write_text("\n".join(rows) + "\n", encoding="utf-8")
            if program["language"] == "python":
                source = directory / "strategy.py"
                source.write_text(program["source"], encoding="utf-8")
                driver = directory / "driver.py"
                driver.write_text(PYTHON_DRIVER, encoding="utf-8")
                command = [sys.executable, "-I", str(driver), str(source)]
            else:
                compiler = shutil.which("g++")
                if compiler is None:
                    raise ValueError("C++ requires g++ on the server PATH. Install a C++17 compiler or use Python.")
                (directory / "strategy.cpp").write_text(program["source"], encoding="utf-8")
                (directory / "driver.cpp").write_text(CPP_DRIVER, encoding="utf-8")
                executable = directory / ("strategy.exe" if os.name == "nt" else "strategy")
                bounded_process([compiler, "-std=c++17", "-O2", "driver.cpp", "-o", str(executable)], directory, data, 30)
                command = [str(executable)]
            output = bounded_process(command, directory, data, 10)
            signals = output.splitlines()
            if len(signals) != len(bars) or any(signal not in ("buy", "sell", "hold") for signal in signals):
                raise ValueError("Algorithm must return one buy/sell/hold signal per bar. Do not print debug output to stdout.")
            return signals
    except OSError as exc:
        raise ValueError(f"Could not launch the local algorithm: {exc}") from exc
    finally:
        RUN_LOCK.release()
