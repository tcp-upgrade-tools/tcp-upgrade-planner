#!/usr/bin/env python3
"""One-off helper: pull readable text from the TCP PDF.

The PDF stores content in FlateDecode streams. We decompress each stream and
recover the text drawn by Tj/TJ operators (parenthesized strings). Font/image
streams decode to binary and are skipped. Output is the concatenated page text,
which we slice around the Upgrade Guide for hand-curation into data/*.json.

Usage:
    python3 tools/extract.py [keyword]
With no keyword it dumps the whole Upgrade Guide region to stdout.
"""
import re
import sys
import zlib

PDF = "vmware-telco-cloud-platform-5-1.pdf"


def octrepl(m):
    try:
        return chr(int(m.group(1), 8))
    except ValueError:
        return m.group(0)


def extract_text(path=PDF):
    data = open(path, "rb").read()
    streams = re.findall(rb"stream\r?\n(.*?)\r?\nendstream", data, re.S)
    parts = []
    for s in streams:
        try:
            d = zlib.decompress(s)
        except Exception:
            continue
        chunk = []
        for t in re.findall(rb"\((?:[^()\\]|\\.)*\)", d):
            ss = t[1:-1].decode("latin-1")
            ss = re.sub(r"\\([0-7]{3})", octrepl, ss)
            ss = ss.replace("\\(", "(").replace("\\)", ")").replace("\\\\", "\\")
            chunk.append(ss)
        if chunk:
            parts.append("".join(chunk))
    return "\n".join(parts)


if __name__ == "__main__":
    full = extract_text()
    if len(sys.argv) > 1:
        kw = sys.argv[1]
        i = full.find(kw)
        print(full[i : i + 4000] if i >= 0 else f"'{kw}' not found")
    else:
        start = full.find("Telco Cloud Platform Upgrade Guide", 100000)
        end = full.find("Harbor for CNFs Deployment and Configuration Guide", start)
        print(full[start:end])
