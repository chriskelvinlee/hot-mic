#!/bin/bash
# Compiles and runs the recording-logic checks without Xcode or SwiftPM.
# Optional arguments: 16 kHz mono 16-bit WAV files of real speech.
set -e; cd "$(dirname "$0")"; OUT="${TMPDIR:-/tmp}/hotmic-selfcheck"
swiftc -O -o "$OUT" Sources/HotMicCore/*.swift Sources/hotmic-selfcheck/main.swift
exec "$OUT" "$@"
