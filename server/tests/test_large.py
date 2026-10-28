"""Large files are never returned whole."""

import pytest

from conftest import running, write

KB = 1024
MB = 1024 * KB


@pytest.fixture
def big(root):
    lines = [f"line {i:07d} " + "x" * 80 + "\n" for i in range(1, 60001)]  # ~5.6 MB
    data = "".join(lines).encode()
    write(root / "big.log", data)
    return root, data, lines


def check_segment(seg, data):
    assert seg["text"].encode() == data[seg["start"]:seg["end"]]
    assert seg["start"] == 0 or data[seg["start"] - 1:seg["start"]] == b"\n"
    assert seg["end"] == len(data) or data[seg["end"] - 1:seg["end"]] == b"\n"
    assert seg["start_line"] == data[:seg["start"]].count(b"\n") + 1


def test_initial_head_and_tail(big):
    root, data, lines = big
    with running(root) as c:
        r = c.get("/api/text?path=big.log").json()
        assert r["size"] == len(data) > 5 * MB
        head, tail = r["segments"]
        assert len(r["gaps"]) == 1
        assert head["start"] == 0 and head["start_line"] == 1
        assert tail["end"] == len(data)
        for s in (head, tail):
            assert s["end"] - s["start"] <= 128 * KB
            assert s["end"] - s["start"] > 100 * KB
            check_segment(s, data)
        assert r["gaps"][0] == {"start": head["end"], "end": tail["start"]}
        assert sum(len(s["text"]) for s in r["segments"]) < len(data) / 10
        assert tail["text"].endswith(lines[-1])


def test_chunk_capped_and_aligned(big):
    root, data, _ = big
    with running(root) as c:
        r = c.get("/api/text", params={"path": "big.log", "start": 12345, "length": 50 * MB}).json()
        (seg,) = r["segments"]
        assert seg["end"] - seg["start"] <= 1 * MB
        check_segment(seg, data)
        assert seg["start"] >= 12345
        r = c.get("/api/text", params={"path": "big.log", "start": len(data) - 1000, "length": 256 * KB}).json()
        check_segment(r["segments"][0], data)
        assert r["segments"][0]["end"] == len(data)


def test_line_lookup(big):
    root, data, lines = big
    with running(root) as c:
        for n in (1, 2, 31337, 60000):
            r = c.get("/api/text", params={"path": "big.log", "line": n}).json()
            (seg,) = r["segments"]
            check_segment(seg, data)
            assert seg["end"] - seg["start"] <= 256 * KB
            got = seg["text"].splitlines(keepends=True)
            assert got[n - seg["start_line"]] == lines[n - 1]


def test_content_413_and_small_file_whole(big):
    root, data, _ = big
    write(root / "small.txt", "é" * 1000 + "\nend")
    with running(root) as c:
        r = c.get("/api/content?path=big.log")
        assert r.status_code == 413 and r.json()["size"] == len(data)
        r = c.get("/api/text?path=small.txt").json()
        assert len(r["segments"]) == 1 and r["gaps"] == []
        assert r["segments"][0]["text"] == "é" * 1000 + "\nend"
        # big file is too large for the search index (default 2 MB)
        assert c.get("/api/search?q=0031337").json()["content"] == []


def test_no_newline_never_splits_utf8(root):
    write(root / "one.txt", "é" * (400 * KB))  # 800 KB single line, 2-byte chars
    with running(root) as c:
        r = c.get("/api/text?path=one.txt").json()
        for s in r["segments"]:
            assert "�" not in s["text"]
        r = c.get("/api/text", params={"path": "one.txt", "start": 1001, "length": 1001}).json()
        assert "�" not in r["segments"][0]["text"]
